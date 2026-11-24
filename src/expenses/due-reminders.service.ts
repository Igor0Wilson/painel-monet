import { Injectable, Logger, Optional } from '@nestjs/common';
import { EmailSenderService } from '../auth/email-sender.service';
import {
  buildDueExpenseEmailHtml,
  buildDueExpenseEmailSubject,
  buildDueExpenseEmailText,
} from '../auth/email-template';
import { AuditService } from '../common/audit.service';
import { decryptDocumentFromStorage } from '../common/data-crypto.utils';
import { FirebaseService } from '../firebase/firebase.service';
import {
  COLLECTIONS,
  ExpenseDoc,
  ExpenseReminderDoc,
  ExpenseReminderKind,
  UserDoc,
} from '../firebase/firebase.types';
import {
  addDaysDateOnly,
  DateParts,
  formatDateOnly,
  getBrazilTodayParts,
  getDaysInMonth,
  getMonthKeyFromParts,
  parseDateOnly,
  parseMonthKey,
} from '../income/income.date-utils';

export interface DueExpenseReminderItem {
  id: string;
  expenseId: string;
  expenseName: string;
  amount: number;
  dueDate: string;
  kind: ExpenseReminderKind;
  alreadyDeviceNotified: boolean;
  emailSent: boolean;
}

const DEFAULT_FRONTEND_URL = 'https://painel-monet-front.vercel.app';
const REMINDER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function formatCurrencyBrForEmail(amount: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(amount) || 0);
}

function formatDateBrForEmail(isoDate: string): string {
  const parts = String(isoDate).split('T')[0].split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

@Injectable()
export class DueRemindersService {
  private readonly logger = new Logger(DueRemindersService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly emailSender: EmailSenderService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private resolveFrontendUrl(): string {
    const raw = process.env.FRONTEND_URL?.trim();
    if (!raw) return DEFAULT_FRONTEND_URL;
    return raw.replace(/\/+$/, '');
  }

  resolveExpenseReminderMatch(
    expense: ExpenseDoc,
    today: DateParts,
    tomorrow: DateParts,
  ): { kind: ExpenseReminderKind; dueDateIso: string } | null {
    if (!expense || expense.isPaid) {
      return null;
    }

    if (expense.paymentMethod === 'credito' && !expense.isCreditCard) {
      return null;
    }

    const todayIso = formatDateOnly(today);
    const tomorrowIso = formatDateOnly(tomorrow);

    if (expense.isRecurring) {
      const start = parseDateOnly(expense.dueDate);
      if (!start.year || !start.month || !start.day) return null;
      const startMonthIdx = start.year * 12 + (start.month - 1);
      const parsedEnd = parseMonthKey(expense.recurrenceEndMonth);
      const endMonthIdx = parsedEnd ? parsedEnd.monthIndex : Number.POSITIVE_INFINITY;

      const candidateMonths: { year: number; month: number }[] = [
        { year: today.year, month: today.month },
      ];
      if (tomorrow.year !== today.year || tomorrow.month !== today.month) {
        candidateMonths.push({ year: tomorrow.year, month: tomorrow.month });
      }

      for (const candidate of candidateMonths) {
        const candidateMonthIdx = candidate.year * 12 + (candidate.month - 1);
        if (candidateMonthIdx < startMonthIdx || candidateMonthIdx > endMonthIdx) continue;
        const mKey = getMonthKeyFromParts(candidate);
        const ov = expense.monthlyOverrides?.[mKey];
        if (ov?.skipped || ov?.materializedExpenseId) continue;

        const clampedDay = Math.min(
          ov?.day ?? start.day,
          getDaysInMonth(candidate.year, candidate.month),
        );
        const occIso = formatDateOnly({
          year: candidate.year,
          month: candidate.month,
          day: clampedDay,
        });
        if (occIso === todayIso) {
          return { kind: 'due_today', dueDateIso: occIso };
        }
        if (occIso === tomorrowIso) {
          return { kind: 'due_tomorrow', dueDateIso: occIso };
        }
      }
      return null;
    }

    const cleanDue = String(expense.dueDate || '').split('T')[0];
    if (cleanDue === todayIso) {
      return { kind: 'due_today', dueDateIso: cleanDue };
    }
    if (cleanDue === tomorrowIso) {
      return { kind: 'due_tomorrow', dueDateIso: cleanDue };
    }
    return null;
  }

  async checkAndDispatchUserReminders(
    userId: string,
    options?: {
      sendEmails?: boolean;
      todayOverride?: DateParts;
    },
  ): Promise<{
    serverDate: string;
    reminders: DueExpenseReminderItem[];
    emailsSentCount: number;
  }> {
    const today = options?.todayOverride || getBrazilTodayParts();
    const todayIso = formatDateOnly(today);
    const tomorrow = parseDateOnly(addDaysDateOnly(today, 1));
    const sendEmails = options?.sendEmails !== false;

    const user = await this.firebase.findById<UserDoc>(COLLECTIONS.USERS, userId);
    if (!user || !user.isActive) {
      return { serverDate: todayIso, reminders: [], emailsSentCount: 0 };
    }

    const expenses = await this.firebase.findByField<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      'userId',
      userId,
    );

    const reminders: DueExpenseReminderItem[] = [];
    let emailsSentCount = 0;

    for (const expense of expenses) {
      const match = this.resolveExpenseReminderMatch(expense, today, tomorrow);
      if (!match) continue;

      const reminderId = `${expense.id}_${match.dueDateIso}_${match.kind}`;
      let reminderDoc = await this.firebase.findById<ExpenseReminderDoc>(
        COLLECTIONS.EXPENSE_REMINDERS,
        reminderId,
      );

      const nowIso = new Date().toISOString();
      if (!reminderDoc) {
        reminderDoc = {
          id: reminderId,
          userId,
          expenseId: expense.id,
          dueDate: match.dueDateIso,
          kind: match.kind,
          emailSentAt: null,
          deviceNotifiedAt: null,
          createdAt: nowIso,
          expiresAtMs: Date.now() + REMINDER_TTL_MS,
        };
        await this.firebase.setDoc(COLLECTIONS.EXPENSE_REMINDERS, reminderDoc);
      }

      const originalVal = Number(expense.value || 0);
      const alreadyPaid = Number(expense.paidAmount || 0);
      const remainingAmount = Number(
        Math.max(0, originalVal - alreadyPaid).toFixed(2),
      );
      const displayAmount = remainingAmount > 0 ? remainingAmount : originalVal;

      if (
        sendEmails &&
        !reminderDoc.emailSentAt &&
        user.email &&
        this.emailSender.hasCustomProvider()
      ) {
        try {
          const frontendUrl = this.resolveFrontendUrl();
          const emailParams = {
            userName: user.name || 'Cliente',
            expenseName: expense.name,
            amountFormatted: formatCurrencyBrForEmail(displayAmount),
            dueDateFormatted: formatDateBrForEmail(match.dueDateIso),
            kind: match.kind,
            actionUrl: `${frontendUrl}/dashboard`,
            logoUrl: `${frontendUrl}/logo192.png?v=5`,
          };
          const emailResult = await this.emailSender.sendHtmlEmail({
            toEmail: user.email,
            toName: user.name || 'Cliente',
            subject: buildDueExpenseEmailSubject(emailParams),
            html: buildDueExpenseEmailHtml(emailParams),
            text: buildDueExpenseEmailText(emailParams),
          });
          if (emailResult.sent) {
            const sentAt = new Date().toISOString();
            reminderDoc.emailSentAt = sentAt;
            emailsSentCount += 1;
            await this.firebase.updateDoc(
              COLLECTIONS.EXPENSE_REMINDERS,
              reminderId,
              { emailSentAt: sentAt },
            );
          }
        } catch (err) {
          this.logger.warn(
            `Falha ao enviar lembrete de vencimento para conta ${expense.id}: ${err instanceof Error ? err.message : 'erro desconhecido'}`,
          );
        }
      }

      reminders.push({
        id: reminderId,
        expenseId: expense.id,
        expenseName: expense.name,
        amount: displayAmount,
        dueDate: match.dueDateIso,
        kind: match.kind,
        alreadyDeviceNotified: Boolean(reminderDoc.deviceNotifiedAt),
        emailSent: Boolean(reminderDoc.emailSentAt),
      });
    }

    reminders.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'due_today' ? -1 : 1;
      return a.dueDate.localeCompare(b.dueDate);
    });

    return {
      serverDate: todayIso,
      reminders,
      emailsSentCount,
    };
  }

  async acknowledgeDeviceNotifications(
    userId: string,
    ids: string[],
  ): Promise<{ acknowledgedCount: number }> {
    const uniqueIds = Array.from(
      new Set((ids || []).map((v) => String(v || '').trim()).filter(Boolean)),
    ).slice(0, 50);

    let acknowledgedCount = 0;
    const nowIso = new Date().toISOString();

    for (const id of uniqueIds) {
      const existing = await this.firebase.findById<ExpenseReminderDoc>(
        COLLECTIONS.EXPENSE_REMINDERS,
        id,
      );
      if (!existing || existing.userId !== userId) {
        continue;
      }
      if (!existing.deviceNotifiedAt) {
        await this.firebase.updateDoc(COLLECTIONS.EXPENSE_REMINDERS, id, {
          deviceNotifiedAt: nowIso,
        });
        acknowledgedCount += 1;
      }
    }

    return { acknowledgedCount };
  }

  async dispatchAllActiveUsersCron(todayOverride?: DateParts): Promise<{
    serverDate: string;
    usersProcessed: number;
    emailsSentCount: number;
  }> {
    const today = todayOverride || getBrazilTodayParts();
    const todayIso = formatDateOnly(today);
    const snap = await this.firebase
      .collection(COLLECTIONS.USERS)
      .where('isActive', '==', true)
      .get();

    let usersProcessed = 0;
    let totalEmailsSent = 0;
    const userIds: string[] = [];

    for (const docSnap of snap.docs) {
      const raw = docSnap.data() as Record<string, unknown>;
      const decrypted = decryptDocumentFromStorage(COLLECTIONS.USERS, raw) as unknown as UserDoc;
      if (decrypted?.id && decrypted.isActive) {
        userIds.push(decrypted.id);
      }
    }

    for (let i = 0; i < userIds.length; i += 5) {
      const chunk = userIds.slice(i, i + 5);
      const results = await Promise.allSettled(
        chunk.map((uid) =>
          this.checkAndDispatchUserReminders(uid, {
            sendEmails: true,
            todayOverride: today,
          }),
        ),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          usersProcessed += 1;
          totalEmailsSent += r.value.emailsSentCount;
        }
      }
    }

    void this.auditService?.log({
      actorUserId: 'cron:due-reminders',
      action: 'expenses.cron.due_reminders',
      resource: 'expense_reminders',
      outcome: 'ALLOW',
      details: `date=${todayIso},users=${usersProcessed},emails=${totalEmailsSent}`,
    });

    return {
      serverDate: todayIso,
      usersProcessed,
      emailsSentCount: totalEmailsSent,
    };
  }
}
