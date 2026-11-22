import { UnauthorizedException } from '@nestjs/common';
import { EmailSenderService } from '../../src/auth/email-sender.service';
import { BalanceService } from '../../src/balance/balance.service';
import { DueRemindersCronController } from '../../src/expenses/due-reminders-cron.controller';
import { DueRemindersService } from '../../src/expenses/due-reminders.service';
import { ExpensesService } from '../../src/expenses/expenses.service';
import { FamilyService } from '../../src/family/family.service';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { IncomeService } from '../../src/income/income.service';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

describe('DueRemindersService & Early Payment Discount Calculations', () => {
  let firebase: InMemoryFirebaseService;
  let expensesService: ExpensesService;
  let incomeService: IncomeService;
  let balanceService: BalanceService;
  let dueRemindersService: DueRemindersService;
  let sentEmails: Array<{ toEmail: string; subject: string; text: string; html: string }>;

  beforeEach(async () => {
    firebase = new InMemoryFirebaseService();
    sentEmails = [];

    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor Wilson',
      email: 'igor@example.com',
      cpf: '52998224725',
      phone: '11999990000',
      firebaseUid: 'fb-1',
      authProvider: 'password',
      isActive: true,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 0,
      externalEmergencyFund: 0,
      investments: 0,
      externalInvestments: 0,
      foodAllowance: 0,
      createdAt: '',
      updatedAt: '',
    });

    await firebase.setDoc(COLLECTIONS.ACCOUNT_TYPES, {
      id: 'cat-moradia',
      name: 'Moradia',
      userId: 'u-1',
      createdAt: '',
      updatedAt: '',
    });

    const familyService = new FamilyService(firebase as unknown as FirebaseService);
    expensesService = new ExpensesService(
      firebase as unknown as FirebaseService,
      familyService,
    );
    incomeService = new IncomeService(
      firebase as unknown as FirebaseService,
      familyService,
    );
    balanceService = new BalanceService(
      firebase as unknown as FirebaseService,
      familyService,
    );

    const mockEmailSender: Partial<EmailSenderService> = {
      hasCustomProvider: () => true,
      sendHtmlEmail: async (params) => {
        sentEmails.push({
          toEmail: params.toEmail,
          subject: params.subject,
          text: params.text,
          html: params.html,
        });
        return { sent: true, provider: 'brevo' };
      },
    };

    dueRemindersService = new DueRemindersService(
      firebase as unknown as FirebaseService,
      mockEmailSender as EmailSenderService,
    );
  });

  it('computes balance and chart totals using discounted paid amount while preserving original bill value', async () => {
    await incomeService.create(
      {
        name: 'Salário Mensal',
        value: 1000,
        isRecurring: false,
        incomeDate: '2026-11-01',
      },
      'u-1',
    );

    const expense = await expensesService.create(
      {
        name: 'Fatura Internet',
        accountTypeId: 'cat-moradia',
        value: 200,
        dueDate: '2026-11-22',
        isRecurring: false,
      },
      'u-1',
    );

    const paidResult = await expensesService.markAsPaid(expense.id, 'u-1', {
      paymentMethod: 'pix',
      isEarlyPayment: true,
      amount: 170,
      paidAt: '2026-11-15',
    });

    expect(paidResult.isPaid).toBe(true);
    expect(paidResult.isPartiallyPaid).toBe(false);
    expect(paidResult.isEarlyPayment).toBe(true);
    expect(paidResult.value).toBe(200);
    expect(paidResult.paidAmount).toBe(170);
    expect(paidResult.discountAmount).toBe(30);
    expect(paidResult.remainingAmount).toBe(0);

    const balance = await balanceService.getBalance('u-1', 'individual');
    expect(balance.totalExpenses).toBe(170);
    expect(balance.balance).toBe(830);

    const charts = await balanceService.getChartData('u-1', '2026-11', 'individual');
    expect(charts.monthSummary.totalExpenses).toBe(170);
    expect(charts.expensesByCategory).toEqual([{ name: 'Moradia', value: 170 }]);

    const undone = await expensesService.undoPayment(expense.id, 'u-1');
    expect(undone.isPaid).toBe(false);
    expect(undone.isEarlyPayment).toBe(false);
    expect(undone.discountAmount).toBe(0);
    expect(undone.paidAmount).toBe(0);
    expect(undone.remainingAmount).toBe(200);

    const balanceAfterUndo = await balanceService.getBalance('u-1', 'individual');
    expect(balanceAfterUndo.totalExpenses).toBe(0);
    expect(balanceAfterUndo.balance).toBe(1000);
  });

  it('sends due-tomorrow email/alert on day 21, due-today on day 22, avoids duplicates, and skips paid bills', async () => {
    const unpaidBill = await expensesService.create(
      {
        name: 'Energia Elétrica',
        accountTypeId: 'cat-moradia',
        value: 250,
        dueDate: '2026-11-22',
        isRecurring: false,
      },
      'u-1',
    );

    const paidBill = await expensesService.create(
      {
        name: 'Água',
        accountTypeId: 'cat-moradia',
        value: 90,
        dueDate: '2026-11-22',
        isRecurring: false,
        isPaid: true,
        paymentMethod: 'pix',
      },
      'u-1',
    );
    expect(paidBill.isPaid).toBe(true);

    // Day 21 -> due tomorrow
    const day21Res = await dueRemindersService.checkAndDispatchUserReminders(
      'u-1',
      {
        sendEmails: true,
        todayOverride: { year: 2026, month: 11, day: 21 },
      },
    );

    expect(day21Res.reminders).toHaveLength(1);
    expect(day21Res.reminders[0].expenseId).toBe(unpaidBill.id);
    expect(day21Res.reminders[0].kind).toBe('due_tomorrow');
    expect(day21Res.emailsSentCount).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].subject).toContain('vence amanhã');
    expect(sentEmails[0].html).toContain('vence amanhã');

    // Re-check same day 21 -> no duplicate email
    const day21Repeat = await dueRemindersService.checkAndDispatchUserReminders(
      'u-1',
      {
        sendEmails: true,
        todayOverride: { year: 2026, month: 11, day: 21 },
      },
    );
    expect(day21Repeat.emailsSentCount).toBe(0);
    expect(sentEmails).toHaveLength(1);

    // Ack device notification on day 21
    const ackRes = await dueRemindersService.acknowledgeDeviceNotifications(
      'u-1',
      [day21Res.reminders[0].id],
    );
    expect(ackRes.acknowledgedCount).toBe(1);

    // Day 22 -> due today
    const day22Res = await dueRemindersService.checkAndDispatchUserReminders(
      'u-1',
      {
        sendEmails: true,
        todayOverride: { year: 2026, month: 11, day: 22 },
      },
    );
    expect(day22Res.reminders).toHaveLength(1);
    expect(day22Res.reminders[0].kind).toBe('due_today');
    expect(day22Res.reminders[0].alreadyDeviceNotified).toBe(false);
    expect(sentEmails).toHaveLength(2);
    expect(sentEmails[1].subject).toContain('vence hoje');

    // Mark bill as paid on day 22 morning -> no more notifications on re-check
    await expensesService.markAsPaid(unpaidBill.id, 'u-1', {
      paymentMethod: 'pix',
    });

    const afterPaidRes =
      await dueRemindersService.checkAndDispatchUserReminders('u-1', {
        sendEmails: true,
        todayOverride: { year: 2026, month: 11, day: 22 },
      });
    expect(afterPaidRes.reminders).toHaveLength(0);
    expect(afterPaidRes.emailsSentCount).toBe(0);
  });

  it('protects cron endpoint with CRON_SECRET timing-safe check', async () => {
    const controller = new DueRemindersCronController(dueRemindersService);
    const prevSecret = process.env.CRON_SECRET;

    try {
      process.env.CRON_SECRET = 'super-strong-cron-secret-value-2026';

      await expect(controller.triggerDueRemindersGet(undefined)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(
        controller.triggerDueRemindersGet('Bearer wrong-secret'),
      ).rejects.toThrow(UnauthorizedException);

      const spy = jest
        .spyOn(dueRemindersService, 'dispatchAllActiveUsersCron')
        .mockResolvedValue({
          serverDate: '2026-11-21',
          usersProcessed: 1,
          emailsSentCount: 1,
        });

      const okRes = await controller.triggerDueRemindersGet(
        'Bearer super-strong-cron-secret-value-2026',
      );
      expect(okRes.usersProcessed).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      if (prevSecret === undefined) {
        delete process.env.CRON_SECRET;
      } else {
        process.env.CRON_SECRET = prevSecret;
      }
    }
  });
});
