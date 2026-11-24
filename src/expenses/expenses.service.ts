import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import { normalizeOfficialCategory } from '../account-types/account-types.service';
import { AuditService } from '../common/audit.service';
import {
  buildProtectedMediaPath,
  CloudinaryService,
  type UploadedImageFile,
} from '../common/cloudinary.service';
import type { DecryptedMediaPayload } from '../common/data-crypto.utils';
import { FamilyService } from '../family/family.service';
import { FirebaseService } from '../firebase/firebase.service';
import {
  AccountTypeDoc,
  COLLECTIONS,
  ExpenseDoc,
  ExpenseMonthlyOverride,
  ExpensePaymentMethod,
  ExpensePaymentPart,
} from '../firebase/firebase.types';
import {
  addMonthsDateOnly,
  compareDateParts,
  formatDateOnly,
  getDaysInMonth,
  getMonthKeyFromParts,
  getTodayParts,
  parseDateOnly,
  parseMonthKey,
  shiftMonthKey,
} from '../income/income.date-utils';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { CreateFoodExpensesBatchDto } from './dto/food-expenses.dto';
import { GenerateCardInvoiceDto } from './dto/generate-card-invoice.dto';
import { PayCreditCardInvoiceDto } from './dto/pay-credit-card-invoice.dto';
import { PayExpenseDto } from './dto/pay-expense.dto';
import { PayExpensesBatchDto } from './dto/pay-expenses-batch.dto';
import { UndoPaymentDto } from './dto/undo-payment.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';

export type ExpenseStatus = 'pago' | 'em_atraso' | 'pendente';

export interface ExpenseWithStatus extends ExpenseDoc {
  status: ExpenseStatus;
  paidAmount: number;
  discountAmount: number;
  isEarlyPayment: boolean;
  remainingAmount: number;
  isPartiallyPaid: boolean;
  paidAt: string | null;
  payments: ExpensePaymentPart[];
  accountType?: { id: string; name: string } | null;
  ownerId?: string;
  ownerName?: string;
  isOwn?: boolean;
  generatedInstallments?: ExpenseWithStatus[];
}

function isCreditCardCategoryName(name?: string | null): boolean {
  if (!name) return false;
  const normalized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalized.includes('cartao') && normalized.includes('credito');
}

function normalizeOptionalText(raw?: string | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCardLast4(raw?: string | null): string | null {
  if (raw === undefined || raw === null) return null;
  const digits = String(raw).replace(/\D/g, '').slice(0, 4);
  return digits.length === 4 ? digits : null;
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly familyService: FamilyService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly cloudinaryService?: CloudinaryService,
  ) { }

  private calcularStatus(expense: ExpenseDoc): ExpenseStatus {
    if (expense.isPaid) return 'pago';

    const today = getTodayParts();
    const dueParts = parseDateOnly(expense.dueDate);

    if (expense.isRecurring) {
      const startMonthIdx = dueParts.year * 12 + (dueParts.month - 1);
      const todayMonthIdx = today.year * 12 + (today.month - 1);
      if (startMonthIdx > todayMonthIdx) {
        return 'pendente';
      }

      const parsedEnd = parseMonthKey(expense.recurrenceEndMonth);
      if (parsedEnd && todayMonthIdx > parsedEnd.monthIndex) {
        return 'pendente';
      }

      const todayKey = getMonthKeyFromParts(today);
      const ov = expense.monthlyOverrides?.[todayKey];
      if (ov?.skipped || ov?.materializedExpenseId) {
        return 'pendente';
      }

      const targetDay = ov?.day ?? dueParts.day;
      const clampedDay = Math.min(
        targetDay,
        getDaysInMonth(today.year, today.month),
      );
      const currentMonthDue = {
        year: today.year,
        month: today.month,
        day: clampedDay,
      };
      return compareDateParts(currentMonthDue, today) < 0
        ? 'em_atraso'
        : 'pendente';
    }

    return compareDateParts(dueParts, today) < 0 ? 'em_atraso' : 'pendente';
  }

  private async materializeRecurringOccurrence(
    expense: ExpenseDoc,
    occMonth: string,
    userId: string,
  ): Promise<ExpenseDoc> {
    const parsedMonth = parseMonthKey(occMonth);
    if (!parsedMonth) {
      throw new BadRequestException('Informe um mês válido no formato AAAA-MM.');
    }

    const startParts = parseDateOnly(expense.dueDate);
    const startMonth = getMonthKeyFromParts(startParts);
    if (occMonth < startMonth) {
      throw new BadRequestException(
        'O mês selecionado é anterior ao início desta despesa recorrente.',
      );
    }
    if (expense.recurrenceEndMonth && occMonth > expense.recurrenceEndMonth) {
      throw new BadRequestException(
        'O mês selecionado está após o encerramento desta recorrência.',
      );
    }

    const existingOv = expense.monthlyOverrides?.[occMonth];
    if (existingOv?.materializedExpenseId) {
      const existingMat = await this.firebase.findById<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        existingOv.materializedExpenseId,
      );
      if (existingMat && existingMat.userId === userId) {
        return existingMat;
      }
    }

    const allUserExpenses = await this.firebase.findByField<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      'userId',
      userId,
    );
    const matched = allUserExpenses.find(
      (e) =>
        e.recurrenceParentId === expense.id && e.occurrenceMonth === occMonth,
    );
    if (matched) {
      return matched;
    }

    const now = new Date().toISOString();
    const clampedDay = Math.min(
      existingOv?.day ?? startParts.day,
      getDaysInMonth(parsedMonth.year, parsedMonth.month),
    );
    const occDate = formatDateOnly({
      year: parsedMonth.year,
      month: parsedMonth.month,
      day: clampedDay,
    });

    const materialized: ExpenseDoc = {
      id: uuidv4(),
      userId,
      accountTypeId: existingOv?.accountTypeId ?? expense.accountTypeId,
      name: existingOv?.name ?? expense.name,
      value:
        existingOv?.value !== undefined
          ? Number(existingOv.value)
          : Number(expense.value),
      dueDate: occDate,
      isRecurring: false,
      recurrenceParentId: expense.id,
      occurrenceMonth: occMonth,
      recurrenceGroupId: expense.recurrenceGroupId ?? null,
      isInstallment: false,
      installmentCount: null,
      installmentNumber: null,
      parentExpenseId: null,
      isPaid: false,
      paidAmount: 0,
      paidAt: null,
      payments: [],
      isCreditCard: Boolean(expense.isCreditCard),
      paymentMethod: null,
      pixKey: expense.pixKey ?? null,
      isAutoDebit: Boolean(expense.isAutoDebit),
      cardBank: expense.cardBank ?? null,
      cardLast4: expense.cardLast4 ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.firebase.setDoc(COLLECTIONS.EXPENSES, materialized);

    const nextOverrides: Record<string, ExpenseMonthlyOverride> = {
      ...(expense.monthlyOverrides || {}),
      [occMonth]: {
        ...(existingOv || {}),
        skipped: false,
        materializedExpenseId: materialized.id,
      },
    };
    await this.firebase.updateDoc(COLLECTIONS.EXPENSES, expense.id, {
      monthlyOverrides: nextOverrides,
      updatedAt: now,
    });

    return materialized;
  }

  private splitValueInCents(totalValue: number, count: number): number[] {
    const totalCents = Math.round(totalValue * 100);
    const baseCents = Math.floor(totalCents / count);
    const values: number[] = [];

    for (let i = 0; i < count; i++) {
      const cents =
        i === count - 1 ? totalCents - baseCents * (count - 1) : baseCents;
      values.push(Number((cents / 100).toFixed(2)));
    }
    return values;
  }

  private getEffectiveExpenseValue(expense: ExpenseDoc): number {
    const val = Number(expense.value || 0);
    if (
      expense.isPaid &&
      expense.isEarlyPayment &&
      expense.paidAmount !== undefined &&
      expense.paidAmount !== null &&
      Number(expense.paidAmount) > 0
    ) {
      return Number(Math.min(val, Number(expense.paidAmount)).toFixed(2));
    }
    return Number(val.toFixed(2));
  }

  private resolveExpensePaymentSummary(expense: ExpenseDoc): {
    totalValue: number;
    paidAmount: number;
    discountAmount: number;
    isEarlyPayment: boolean;
    remainingAmount: number;
    isPaid: boolean;
    isPartiallyPaid: boolean;
    paidAt: string | null;
    payments: ExpensePaymentPart[];
  } {
    const totalValue = Number(Number(expense.value || 0).toFixed(2));
    const isEarlyPayment = Boolean(expense.isEarlyPayment);
    const rawPayments = Array.isArray(expense.payments) ? expense.payments : [];
    const sortedPayments = [...rawPayments]
      .filter((p) => p && Number(p.amount) > 0)
      .map((p) => ({
        id: String(p.id || uuidv4()),
        amount: Number(Number(p.amount).toFixed(2)),
        paidAt: String(p.paidAt || '').split('T')[0],
        paymentMethod: (p.paymentMethod || 'dinheiro') as ExpensePaymentMethod,
        createdAt: p.createdAt,
      }))
      .sort((a, b) => a.paidAt.localeCompare(b.paidAt));

    let paidAmount: number;
    if (sortedPayments.length > 0) {
      paidAmount = Number(
        sortedPayments.reduce((sum, p) => sum + p.amount, 0).toFixed(2),
      );
    } else if (
      expense.paidAmount !== undefined &&
      expense.paidAmount !== null &&
      Number(expense.paidAmount) > 0
    ) {
      paidAmount = Number(Number(expense.paidAmount).toFixed(2));
    } else {
      paidAmount = expense.isPaid ? totalValue : 0;
    }

    if (expense.isPaid && !isEarlyPayment && paidAmount < totalValue - 0.009) {
      paidAmount = totalValue;
    }

    paidAmount = Math.max(0, Math.min(totalValue, Number(paidAmount.toFixed(2))));
    const computedDiscount =
      expense.isPaid && isEarlyPayment
        ? Number(Math.max(0, totalValue - paidAmount).toFixed(2))
        : 0;
    const discountAmount =
      computedDiscount > 0
        ? computedDiscount
        : expense.isPaid && isEarlyPayment && Number(expense.discountAmount || 0) > 0
          ? Number(Number(expense.discountAmount).toFixed(2))
          : 0;
    const isPaid =
      Boolean(expense.isPaid) ||
      (totalValue > 0 && Number((totalValue - paidAmount).toFixed(2)) <= 0.009);
    const remainingAmount = isPaid
      ? 0
      : Number(Math.max(0, totalValue - paidAmount).toFixed(2));
    const isPartiallyPaid = !isPaid && paidAmount > 0.009;
    const paidAt =
      expense.paidAt ||
      (sortedPayments.length > 0
        ? sortedPayments[sortedPayments.length - 1].paidAt
        : null) ||
      null;

    return {
      totalValue,
      paidAmount,
      discountAmount,
      isEarlyPayment: isEarlyPayment && discountAmount > 0,
      remainingAmount,
      isPaid,
      isPartiallyPaid,
      paidAt,
      payments: sortedPayments,
    };
  }

  private toExpenseWithStatus(
    expense: ExpenseDoc,
    extras?: Partial<ExpenseWithStatus>,
  ): ExpenseWithStatus {
    const summary = this.resolveExpensePaymentSummary(expense);
    const normalizedDoc: ExpenseDoc = {
      ...expense,
      isPaid: summary.isPaid,
      paidAmount: summary.paidAmount,
      discountAmount: summary.discountAmount,
      isEarlyPayment: summary.isEarlyPayment,
      paidAt: summary.paidAt,
      payments: summary.payments,
      receiptUrl: buildProtectedMediaPath(
        'expense',
        expense.id,
        expense.receiptUrl,
        expense.receiptPublicId,
      ),
      receiptPublicId: null,
    };

    return {
      ...normalizedDoc,
      paidAmount: summary.paidAmount,
      discountAmount: summary.discountAmount,
      isEarlyPayment: summary.isEarlyPayment,
      remainingAmount: summary.remainingAmount,
      isPartiallyPaid: summary.isPartiallyPaid,
      paidAt: summary.paidAt,
      payments: summary.payments,
      status: this.calcularStatus(normalizedDoc),
      ...extras,
    };
  }

  private async createCreditCardEntries(params: {
    userId: string;
    accountTypeId: string;
    baseName: string;
    totalValue: number;
    installments: number;
    firstInstallmentDate: string;
    sourceExpenseId?: string | null;
    pixKey?: string | null;
    isAutoDebit?: boolean;
    cardBank?: string | null;
    cardLast4?: string | null;
  }): Promise<ExpenseWithStatus[]> {
    const {
      userId,
      accountTypeId,
      baseName,
      totalValue,
      installments,
      firstInstallmentDate,
      sourceExpenseId,
      pixKey,
      isAutoDebit,
      cardBank,
      cardLast4,
    } = params;

    const installmentValues = this.splitValueInCents(totalValue, installments);
    const created: ExpenseWithStatus[] = [];
    const now = new Date().toISOString();

    if (installments === 1) {
      const singleBill: ExpenseDoc = {
        id: uuidv4(),
        userId,
        accountTypeId,
        name: `${baseName} [Crédito 1/1]`,
        value: installmentValues[0],
        dueDate: firstInstallmentDate,
        isRecurring: false,
        isInstallment: false,
        installmentCount: null,
        installmentNumber: null,
        parentExpenseId: null,
        sourceExpenseId: sourceExpenseId ?? null,
        isPaid: false,
        paidAmount: 0,
        paidAt: null,
        payments: [],
        isCreditCard: true,
        paymentMethod: null,
        pixKey: normalizeOptionalText(pixKey),
        isAutoDebit: Boolean(isAutoDebit),
        cardBank: normalizeOptionalText(cardBank),
        cardLast4: normalizeCardLast4(cardLast4),
        createdAt: now,
        updatedAt: now,
      };
      await this.firebase.setDoc(COLLECTIONS.EXPENSES, singleBill);
      created.push(this.toExpenseWithStatus(singleBill));
    } else {
      const parentId = uuidv4();
      for (let i = 0; i < installments; i++) {
        const parcela: ExpenseDoc = {
          id: i === 0 ? parentId : uuidv4(),
          userId,
          accountTypeId,
          name: `${baseName} [Crédito] (${i + 1}/${installments})`,
          value: installmentValues[i],
          dueDate: addMonthsDateOnly(firstInstallmentDate, i),
          isRecurring: false,
          isInstallment: true,
          installmentCount: installments,
          installmentNumber: i + 1,
          parentExpenseId: i === 0 ? null : parentId,
          sourceExpenseId: sourceExpenseId ?? null,
          isPaid: false,
          paidAmount: 0,
          paidAt: null,
          payments: [],
          isCreditCard: true,
          paymentMethod: null,
          pixKey: normalizeOptionalText(pixKey),
          isAutoDebit: Boolean(isAutoDebit),
          cardBank: normalizeOptionalText(cardBank),
          cardLast4: normalizeCardLast4(cardLast4),
          createdAt: now,
          updatedAt: now,
        };
        await this.firebase.setDoc(COLLECTIONS.EXPENSES, parcela);
        created.push(this.toExpenseWithStatus(parcela));
      }
    }

    return created;
  }

  async findAll(userId: string, scope?: string): Promise<ExpenseWithStatus[]> {
    const authScope = await this.familyService.resolveAuthorizedScope(
      userId,
      scope,
    );

    const visibleUserIds =
      authScope.mode === 'family'
        ? authScope.userIds.filter(
          (uid) =>
            uid === userId ||
            (authScope.memberPermissions?.get(uid)?.viewExpenses ?? true),
        )
        : authScope.userIds;

    const [expenses, accountTypes] = await Promise.all([
      this.firebase.findByFieldIn<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        visibleUserIds,
      ),
      this.firebase.findByFieldIn<AccountTypeDoc>(
        COLLECTIONS.ACCOUNT_TYPES,
        'userId',
        visibleUserIds,
      ),
    ]);

    const typesById = new Map(accountTypes.map((t) => [t.id, t]));

    return expenses
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((e) => {
        const accountType = typesById.get(e.accountTypeId) || null;
        const owner = authScope.userMap.get(e.userId);
        const normalizedCategoryName = normalizeOfficialCategory(
          accountType?.name,
        );
        return this.toExpenseWithStatus(e, {
          accountType: {
            id: accountType?.id || e.accountTypeId || 'diversos',
            name: normalizedCategoryName,
          },
          isCreditCard:
            Boolean(e.isCreditCard) ||
            isCreditCardCategoryName(accountType?.name),
          ownerId: e.userId,
          ownerName: owner?.name || 'Usuário',
          isOwn: e.userId === userId,
        });
      });
  }

  async create(
    dto: CreateExpenseDto,
    userId: string,
  ): Promise<ExpenseWithStatus | ExpenseWithStatus[]> {
    const accountType = await this.firebase.findById<AccountTypeDoc>(
      COLLECTIONS.ACCOUNT_TYPES,
      dto.accountTypeId,
    );
    if (accountType && accountType.userId !== userId) {
      throw new ForbiddenException(
        'Categoria não pertence ao usuário autenticado.',
      );
    }
    const isCardCategory =
      accountType?.userId === userId &&
      isCreditCardCategoryName(accountType?.name);

    const normalizedPixKey = normalizeOptionalText(dto.pixKey);
    const normalizedCardBank = normalizeOptionalText(dto.cardBank);
    const normalizedCardLast4 = normalizeCardLast4(dto.cardLast4);
    const isAutoDebit = Boolean(dto.isAutoDebit);

    let result: ExpenseWithStatus | ExpenseWithStatus[];

    if (
      dto.paymentMethod === 'credito' &&
      !(
        dto.paidAmount !== undefined &&
        dto.paidAmount < Number(dto.value) - 0.009
      )
    ) {
      const installments =
        dto.installmentCount && dto.installmentCount >= 1
          ? dto.installmentCount
          : 1;
      const firstDate = dto.firstInstallmentDate || dto.dueDate;
      const baseName = dto.name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();

      result = await this.createCreditCardEntries({
        userId,
        accountTypeId: dto.accountTypeId,
        baseName,
        totalValue: dto.value,
        installments,
        firstInstallmentDate: firstDate,
        pixKey: normalizedPixKey,
        isAutoDebit,
        cardBank: normalizedCardBank,
        cardLast4: normalizedCardLast4,
      });
    } else if (
      dto.isInstallment &&
      dto.installmentCount &&
      dto.installmentCount >= 2
    ) {
      result = await this.criarParceladas(
        dto,
        userId,
        Boolean(dto.isCreditCard || isCardCategory || dto.isInstallment),
      );
    } else {
      const totalValue = Number(Number(dto.value).toFixed(2));
      const todayIso = formatDateOnly(getTodayParts());
      let isPaid = false;
      let paidAmount = 0;
      let paidAt: string | null = null;
      let resolvedPaymentMethod: ExpensePaymentMethod | null = null;
      let payments: ExpensePaymentPart[] = [];

      if (!dto.isRecurring) {
        if (dto.paidAmount !== undefined) {
          const requestedPaid = Number(Number(dto.paidAmount).toFixed(2));
          if (requestedPaid <= 0) {
            throw new BadRequestException(
              'O valor pago deve ser maior que zero.',
            );
          }
          if (requestedPaid > totalValue + 0.009) {
            throw new BadRequestException(
              'O valor pago não pode ser maior que o valor total da despesa.',
            );
          }
          const method = (dto.paymentMethod || 'dinheiro') as ExpensePaymentMethod;
          const actualPaid =
            requestedPaid >= totalValue - 0.009 ? totalValue : requestedPaid;
          isPaid = actualPaid >= totalValue - 0.009;
          if (!isPaid && method === 'credito') {
            throw new BadRequestException(
              'Pagamento parcial não pode ser parcelado no cartão de crédito. Use pagamento total ou outra forma.',
            );
          }
          paidAmount = actualPaid;
          paidAt = dto.paidAt || todayIso;
          resolvedPaymentMethod = method;
          payments = [
            {
              id: uuidv4(),
              amount: actualPaid,
              paidAt,
              paymentMethod: method,
              createdAt: new Date().toISOString(),
            },
          ];
        } else if (dto.isPaid ?? Boolean(dto.paymentMethod)) {
          isPaid = true;
          paidAmount = totalValue;
          paidAt = dto.paidAt || todayIso;
          resolvedPaymentMethod = (dto.paymentMethod ||
            'dinheiro') as ExpensePaymentMethod;
          payments = [
            {
              id: uuidv4(),
              amount: totalValue,
              paidAt,
              paymentMethod: resolvedPaymentMethod,
              createdAt: new Date().toISOString(),
            },
          ];
        }
      }

      const now = new Date().toISOString();

      const expense: ExpenseDoc = {
        id: uuidv4(),
        name: dto.name.trim(),
        accountTypeId: dto.accountTypeId,
        value: totalValue,
        dueDate: dto.dueDate,
        isRecurring: Boolean(dto.isRecurring),
        isInstallment: false,
        installmentCount: null,
        installmentNumber: null,
        parentExpenseId: null,
        userId,
        isPaid,
        paidAmount,
        paidAt,
        payments,
        isCreditCard: Boolean(dto.isCreditCard || isCardCategory),
        paymentMethod: resolvedPaymentMethod,
        pixKey: normalizedPixKey,
        isAutoDebit,
        cardBank: normalizedCardBank,
        cardLast4: normalizedCardLast4,
        createdAt: now,
        updatedAt: now,
      };

      await this.firebase.setDoc(COLLECTIONS.EXPENSES, expense);
      result = this.toExpenseWithStatus(expense);
    }

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    return result;
  }

  private async criarParceladas(
    dto: CreateExpenseDto,
    userId: string,
    isCreditCard = true,
  ): Promise<ExpenseWithStatus[]> {
    const parentId = uuidv4();
    const parcelas: ExpenseWithStatus[] = [];
    const count = dto.installmentCount!;
    const installmentValues = this.splitValueInCents(dto.value, count);
    const now = new Date().toISOString();
    const normalizedPixKey = normalizeOptionalText(dto.pixKey);
    const normalizedCardBank = normalizeOptionalText(dto.cardBank);
    const normalizedCardLast4 = normalizeCardLast4(dto.cardLast4);
    const isAutoDebit = Boolean(dto.isAutoDebit);

    for (let i = 0; i < count; i++) {
      const parcela: ExpenseDoc = {
        id: i === 0 ? parentId : uuidv4(),
        userId,
        accountTypeId: dto.accountTypeId,
        name: `${dto.name.trim()} (${i + 1}/${count})`,
        value: installmentValues[i],
        dueDate: addMonthsDateOnly(dto.dueDate, i),
        isRecurring: false,
        isInstallment: true,
        installmentCount: count,
        installmentNumber: i + 1,
        parentExpenseId: i === 0 ? null : parentId,
        isPaid: false,
        paidAmount: 0,
        paidAt: null,
        payments: [],
        isCreditCard,
        paymentMethod: null,
        pixKey: normalizedPixKey,
        isAutoDebit,
        cardBank: normalizedCardBank,
        cardLast4: normalizedCardLast4,
        createdAt: now,
        updatedAt: now,
      };
      await this.firebase.setDoc(COLLECTIONS.EXPENSES, parcela);
      parcelas.push(this.toExpenseWithStatus(parcela));
    }

    return parcelas;
  }

  async markAsPaid(
    id: string,
    userId: string,
    dto?: PayExpenseDto,
  ): Promise<ExpenseWithStatus> {
    let expense = await this.firebase.findById<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      id,
    );
    if (!expense || expense.userId !== userId) {
      throw new NotFoundException('Despesa não encontrada');
    }

    if (expense.isRecurring) {
      const occMonth = dto?.occurrenceMonth || getMonthKeyFromParts(getTodayParts());
      expense = await this.materializeRecurringOccurrence(
        expense,
        occMonth,
        userId,
      );
    }

    const summary = this.resolveExpensePaymentSummary(expense);
    if (summary.isPaid || summary.remainingAmount <= 0.009) {
      throw new BadRequestException('Esta despesa já foi liquidada');
    }

    const paymentMethod = (dto?.paymentMethod || 'dinheiro') as ExpensePaymentMethod;
    const paidDate = dto?.paidAt || formatDateOnly(getTodayParts());
    const now = new Date().toISOString();

    const isEarlyRequested = Boolean(dto?.isEarlyPayment);
    let payAmount = summary.remainingAmount;
    if (dto?.amount !== undefined) {
      const requestedAmount = Number(Number(dto.amount).toFixed(2));
      if (Number.isNaN(requestedAmount) || requestedAmount <= 0) {
        throw new BadRequestException(
          'O valor do pagamento deve ser maior que zero.',
        );
      }
      if (requestedAmount > summary.remainingAmount + 0.009) {
        throw new BadRequestException(
          'O valor informado ultrapassa o saldo restante da despesa.',
        );
      }
      payAmount =
        requestedAmount >= summary.remainingAmount - 0.009
          ? summary.remainingAmount
          : requestedAmount;
    }

    const isEarlyDiscount =
      isEarlyRequested && payAmount < summary.remainingAmount - 0.009;
    const isPartial = !isEarlyRequested && payAmount < summary.remainingAmount - 0.009;

    if (paymentMethod === 'credito' && isPartial) {
      throw new BadRequestException(
        'O parcelamento no cartão de crédito está disponível apenas para pagamento do saldo restante total.',
      );
    }

    const newPart: ExpensePaymentPart = {
      id: uuidv4(),
      amount: payAmount,
      paidAt: paidDate,
      paymentMethod,
      createdAt: now,
    };

    if (paymentMethod !== 'credito') {
      const nextPayments = [...summary.payments, newPart];
      const nextPaidAmount = Number(
        Math.min(summary.totalValue, summary.paidAmount + payAmount).toFixed(2),
      );
      const nextIsPaid =
        isEarlyRequested || nextPaidAmount >= summary.totalValue - 0.009;
      const finalPaidAmount = nextIsPaid
        ? isEarlyDiscount
          ? nextPaidAmount
          : summary.totalValue
        : nextPaidAmount;
      const discountAmount = isEarlyDiscount
        ? Number(Math.max(0, summary.totalValue - finalPaidAmount).toFixed(2))
        : 0;

      await this.firebase.updateDoc(COLLECTIONS.EXPENSES, expense.id, {
        isPaid: nextIsPaid,
        paidAmount: finalPaidAmount,
        discountAmount,
        isEarlyPayment: discountAmount > 0,
        paidAt: paidDate,
        paymentMethod,
        payments: nextPayments,
        updatedAt: now,
      });
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

      void this.auditService?.log({
        actorUserId: userId,
        action: nextIsPaid ? 'expenses.pay' : 'expenses.pay_partial',
        resource: 'expenses',
        resourceId: expense.id,
        outcome: 'ALLOW',
      });

      const updatedDoc: ExpenseDoc = {
        ...expense,
        isPaid: nextIsPaid,
        paidAmount: finalPaidAmount,
        discountAmount,
        isEarlyPayment: discountAmount > 0,
        paidAt: paidDate,
        paymentMethod,
        payments: nextPayments,
        updatedAt: now,
      };
      return this.toExpenseWithStatus(updatedDoc, {
        generatedInstallments: [],
      });
    }

    const installments = dto?.installments;
    const firstInstallmentDate = dto?.firstInstallmentDate;

    if (!installments || installments < 1) {
      throw new BadRequestException(
        'Informe em quantas vezes a compra foi parcelada no cartão de crédito.',
      );
    }
    if (!firstInstallmentDate) {
      throw new BadRequestException(
        'Informe a data de vencimento da primeira parcela do cartão de crédito.',
      );
    }

    const nextPayments = [...summary.payments, newPart];
    const finalCreditPaidAmount = isEarlyDiscount
      ? Number(Math.min(summary.totalValue, summary.paidAmount + payAmount).toFixed(2))
      : summary.totalValue;
    const creditDiscountAmount = isEarlyDiscount
      ? Number(Math.max(0, summary.totalValue - finalCreditPaidAmount).toFixed(2))
      : 0;
    const resolvedCardBank =
      dto?.cardBank !== undefined
        ? normalizeOptionalText(dto.cardBank)
        : expense.cardBank ?? null;
    const resolvedCardLast4 =
      dto?.cardLast4 !== undefined
        ? normalizeCardLast4(dto.cardLast4)
        : expense.cardLast4 ?? null;

    await this.firebase.updateDoc(COLLECTIONS.EXPENSES, expense.id, {
      isPaid: true,
      paidAmount: finalCreditPaidAmount,
      discountAmount: creditDiscountAmount,
      isEarlyPayment: creditDiscountAmount > 0,
      paidAt: paidDate,
      paymentMethod: 'credito',
      cardBank: resolvedCardBank,
      cardLast4: resolvedCardLast4,
      payments: nextPayments,
      updatedAt: now,
    });

    const baseName = expense.name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
    const generatedInstallments = await this.createCreditCardEntries({
      userId,
      accountTypeId: expense.accountTypeId,
      baseName,
      totalValue: payAmount,
      installments,
      firstInstallmentDate,
      sourceExpenseId: expense.id,
      pixKey: expense.pixKey ?? null,
      isAutoDebit: Boolean(expense.isAutoDebit),
      cardBank: resolvedCardBank,
      cardLast4: resolvedCardLast4,
    });

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.pay',
      resource: 'expenses',
      resourceId: expense.id,
      outcome: 'ALLOW',
    });

    const updatedDoc: ExpenseDoc = {
      ...expense,
      isPaid: true,
      paidAmount: finalCreditPaidAmount,
      discountAmount: creditDiscountAmount,
      isEarlyPayment: creditDiscountAmount > 0,
      paidAt: paidDate,
      paymentMethod: 'credito',
      cardBank: resolvedCardBank,
      cardLast4: resolvedCardLast4,
      payments: nextPayments,
      updatedAt: now,
    };
    return this.toExpenseWithStatus(updatedDoc, { generatedInstallments });
  }

  async undoPayment(
    id: string,
    userId: string,
    dto?: UndoPaymentDto,
  ): Promise<ExpenseWithStatus> {
    const expense = await this.firebase.findById<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      id,
    );
    if (!expense || expense.userId !== userId) {
      throw new NotFoundException('Despesa não encontrada');
    }

    const summary = this.resolveExpensePaymentSummary(expense);
    if (
      !summary.isPaid &&
      summary.paidAmount <= 0 &&
      summary.payments.length === 0
    ) {
      throw new BadRequestException(
        'Esta despesa não possui pagamento registrado para desfazer.',
      );
    }

    const linkedCreditItems = await this.firebase.findByField<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      'sourceExpenseId',
      id,
    );
    const ownLinkedCredit = linkedCreditItems.filter((c) => c.userId === userId);

    const removeLinkedOpenCredit = async () => {
      const alreadyPaidChild = ownLinkedCredit.some((c) => {
        const childSummary = this.resolveExpensePaymentSummary(c);
        return childSummary.isPaid || childSummary.paidAmount > 0;
      });
      if (alreadyPaidChild) {
        throw new BadRequestException(
          'Desfaça primeiro o pagamento das parcelas geradas no cartão de crédito.',
        );
      }
      for (const child of ownLinkedCredit) {
        await this.firebase.deleteDoc(COLLECTIONS.EXPENSES, child.id);
      }
    };

    const now = new Date().toISOString();
    let nextPayments: ExpensePaymentPart[] = [];
    let nextPaidAmount = 0;
    let nextPaidAt: string | null = null;
    let nextPaymentMethod: string | null = null;

    if (dto?.paymentId) {
      const targetIdx = summary.payments.findIndex((p) => p.id === dto.paymentId);
      if (targetIdx === -1) {
        throw new NotFoundException('Registro de pagamento não encontrado.');
      }
      const targetPart = summary.payments[targetIdx];
      if (targetPart.paymentMethod === 'credito' && ownLinkedCredit.length > 0) {
        await removeLinkedOpenCredit();
      }
      nextPayments = summary.payments.filter((p) => p.id !== dto.paymentId);
      nextPaidAmount = Number(
        Math.min(
          summary.totalValue,
          nextPayments.reduce((sum, p) => sum + p.amount, 0),
        ).toFixed(2),
      );
      const last =
        nextPayments.length > 0 ? nextPayments[nextPayments.length - 1] : null;
      nextPaidAt = last?.paidAt ?? null;
      nextPaymentMethod = last?.paymentMethod ?? null;
    } else {
      if (
        (expense.paymentMethod === 'credito' ||
          summary.payments.some((p) => p.paymentMethod === 'credito')) &&
        ownLinkedCredit.length > 0
      ) {
        await removeLinkedOpenCredit();
      }
    }

    const nextIsPaid =
      nextPayments.length > 0 && nextPaidAmount >= summary.totalValue - 0.009;

    await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, {
      isPaid: nextIsPaid,
      paidAmount: nextPaidAmount,
      discountAmount: 0,
      isEarlyPayment: false,
      paidAt: nextPaidAt,
      paymentMethod: nextPaymentMethod,
      payments: nextPayments,
      updatedAt: now,
    });

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.undo_pay',
      resource: 'expenses',
      resourceId: id,
      outcome: 'ALLOW',
    });

    const updatedDoc: ExpenseDoc = {
      ...expense,
      isPaid: nextIsPaid,
      paidAmount: nextPaidAmount,
      discountAmount: 0,
      isEarlyPayment: false,
      paidAt: nextPaidAt,
      paymentMethod: nextPaymentMethod,
      payments: nextPayments,
      updatedAt: now,
    };
    return this.toExpenseWithStatus(updatedDoc);
  }

  async payCreditCardInvoice(
    userId: string,
    dto: PayCreditCardInvoiceDto,
  ): Promise<{
    month: string;
    paidCount: number;
    totalPaid: number;
    paymentMethod: string;
    paidIds: string[];
  }> {
    const paymentMethod = dto.paymentMethod || 'pix';
    const filterBank = normalizeOptionalText(dto.cardBank)?.toLowerCase() || null;
    const filterLast4 = normalizeCardLast4(dto.cardLast4);
    const [allUserExpenses, accountTypes] = await Promise.all([
      this.firebase.findByField<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        userId,
      ),
      this.firebase.findByField<AccountTypeDoc>(
        COLLECTIONS.ACCOUNT_TYPES,
        'userId',
        userId,
      ),
    ]);

    const typesById = new Map(accountTypes.map((t) => [t.id, t]));

    const matching = allUserExpenses.filter((exp) => {
      if (exp.isPaid) return false;
      const accountType = typesById.get(exp.accountTypeId);
      const isCard =
        Boolean(exp.isCreditCard) ||
        isCreditCardCategoryName(accountType?.name);
      const dueStr = String(exp.dueDate).split('T')[0];
      if (!isCard || !dueStr.startsWith(dto.month)) return false;
      if (filterLast4 && normalizeCardLast4(exp.cardLast4) !== filterLast4) {
        return false;
      }
      if (
        filterBank &&
        (normalizeOptionalText(exp.cardBank)?.toLowerCase() || '') !== filterBank
      ) {
        return false;
      }
      return true;
    });

    if (matching.length === 0) {
      throw new NotFoundException(
        'Nenhuma compra ou parcela em aberto no cartão de crédito para este mês.',
      );
    }

    const now = new Date().toISOString();
    const paidDate = dto.paidAt || formatDateOnly(getTodayParts());
    let totalPaid = 0;
    const paidIds: string[] = [];

    for (const exp of matching) {
      const summary = this.resolveExpensePaymentSummary(exp);
      const remaining = summary.remainingAmount > 0 ? summary.remainingAmount : Number(exp.value);
      const nextPayments: ExpensePaymentPart[] = [
        ...summary.payments,
        {
          id: uuidv4(),
          amount: remaining,
          paidAt: paidDate,
          paymentMethod: paymentMethod as ExpensePaymentMethod,
          createdAt: now,
        },
      ];

      await this.firebase.updateDoc(COLLECTIONS.EXPENSES, exp.id, {
        isPaid: true,
        paidAmount: Number(exp.value),
        paidAt: paidDate,
        paymentMethod,
        payments: nextPayments,
        updatedAt: now,
      });
      totalPaid += remaining;
      paidIds.push(exp.id);
    }

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.pay_credit_card_invoice',
      resource: 'expenses',
      outcome: 'ALLOW',
      details: `count=${paidIds.length}`,
    });

    return {
      month: dto.month,
      paidCount: matching.length,
      totalPaid: Number(totalPaid.toFixed(2)),
      paymentMethod,
      paidIds,
    };
  }

  async generateCardInvoice(
    userId: string,
    dto: GenerateCardInvoiceDto,
  ): Promise<{
    generatedCount: number;
    totalGenerated: number;
    generatedEntries: ExpenseWithStatus[];
  }> {
    const uniqueIds = Array.from(new Set(dto.expenseIds));
    const docs = await Promise.all(
      uniqueIds.map((id) =>
        this.firebase.findById<ExpenseDoc>(COLLECTIONS.EXPENSES, id),
      ),
    );

    const targets = docs.filter((exp): exp is ExpenseDoc => {
      if (!exp || exp.userId !== userId || exp.isCreditCard) return false;
      const summary = this.resolveExpensePaymentSummary(exp);
      return !summary.isPaid && summary.remainingAmount > 0.009;
    });

    if (targets.length === 0) {
      throw new BadRequestException(
        'Nenhuma conta pendente ou em débito automático elegível para gerar fatura do cartão.',
      );
    }

    const now = new Date().toISOString();
    const paidDate = formatDateOnly(getTodayParts());
    const overrideBank = normalizeOptionalText(dto.cardBank);
    const overrideLast4 = normalizeCardLast4(dto.cardLast4);
    const installments =
      dto.installments && dto.installments >= 1 ? dto.installments : 1;

    let totalGenerated = 0;
    const generatedEntries: ExpenseWithStatus[] = [];

    for (const expense of targets) {
      const summary = this.resolveExpensePaymentSummary(expense);
      const remaining = summary.remainingAmount;
      const cardBank = overrideBank ?? expense.cardBank ?? null;
      const cardLast4 = overrideLast4 ?? expense.cardLast4 ?? null;

      const nextPayments: ExpensePaymentPart[] = [
        ...summary.payments,
        {
          id: uuidv4(),
          amount: remaining,
          paidAt: paidDate,
          paymentMethod: 'credito',
          createdAt: now,
        },
      ];

      await this.firebase.updateDoc(COLLECTIONS.EXPENSES, expense.id, {
        isPaid: true,
        paidAmount: Number(expense.value),
        paidAt: paidDate,
        paymentMethod: 'credito',
        cardBank,
        cardLast4,
        payments: nextPayments,
        updatedAt: now,
      });

      const baseName = expense.name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
      const entries = await this.createCreditCardEntries({
        userId,
        accountTypeId: expense.accountTypeId,
        baseName,
        totalValue: remaining,
        installments,
        firstInstallmentDate: dto.dueDate || expense.dueDate || paidDate,
        sourceExpenseId: expense.id,
        pixKey: expense.pixKey ?? null,
        isAutoDebit: Boolean(expense.isAutoDebit),
        cardBank,
        cardLast4,
      });

      generatedEntries.push(...entries);
      totalGenerated += remaining;
    }

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.generate_card_invoice',
      resource: 'expenses',
      outcome: 'ALLOW',
      details: `count=${targets.length}`,
    });

    return {
      generatedCount: targets.length,
      totalGenerated: Number(totalGenerated.toFixed(2)),
      generatedEntries,
    };
  }

  async payBatch(
    userId: string,
    dto: PayExpensesBatchDto,
  ): Promise<{
    paidCount: number;
    totalPaid: number;
    paymentMethod: string;
    paidIds: string[];
  }> {
    const paymentMethod = dto.paymentMethod;
    if (paymentMethod === 'credito') {
      if (!dto.installments || dto.installments < 1) {
        throw new BadRequestException(
          'Informe em quantas vezes o pagamento no cartão de crédito foi parcelado.',
        );
      }
      if (!dto.firstInstallmentDate) {
        throw new BadRequestException(
          'Informe a data de vencimento da primeira parcela do cartão de crédito.',
        );
      }
    }

    const uniqueIds = Array.from(new Set(dto.expenseIds));
    const docs = await Promise.all(
      uniqueIds.map((id) =>
        this.firebase.findById<ExpenseDoc>(COLLECTIONS.EXPENSES, id),
      ),
    );

    const targets = docs.filter(
      (exp): exp is ExpenseDoc =>
        Boolean(exp) && exp!.userId === userId && !exp!.isPaid,
    );

    if (targets.length === 0) {
      throw new BadRequestException(
        'Nenhuma despesa em aberto encontrada para liquidação em lote.',
      );
    }

    const now = new Date().toISOString();
    const paidDate = dto.paidAt || formatDateOnly(getTodayParts());
    const overrideBank = normalizeOptionalText(dto.cardBank);
    const overrideLast4 = normalizeCardLast4(dto.cardLast4);
    const occMonth = dto.occurrenceMonth || getMonthKeyFromParts(getTodayParts());
    let totalPaid = 0;
    const paidIds: string[] = [];

    for (const rawExpense of targets) {
      const expense = rawExpense.isRecurring
        ? await this.materializeRecurringOccurrence(rawExpense, occMonth, userId)
        : rawExpense;
      const summary = this.resolveExpensePaymentSummary(expense);
      if (summary.isPaid) continue;
      const remaining =
        summary.remainingAmount > 0 ? summary.remainingAmount : Number(expense.value);
      const resolvedCardBank =
        paymentMethod === 'credito'
          ? overrideBank ?? expense.cardBank ?? null
          : expense.cardBank ?? null;
      const resolvedCardLast4 =
        paymentMethod === 'credito'
          ? overrideLast4 ?? expense.cardLast4 ?? null
          : expense.cardLast4 ?? null;
      const nextPayments: ExpensePaymentPart[] = [
        ...summary.payments,
        {
          id: uuidv4(),
          amount: remaining,
          paidAt: paidDate,
          paymentMethod: paymentMethod as ExpensePaymentMethod,
          createdAt: now,
        },
      ];

      await this.firebase.updateDoc(COLLECTIONS.EXPENSES, expense.id, {
        isPaid: true,
        paidAmount: Number(expense.value),
        paidAt: paidDate,
        paymentMethod,
        cardBank: resolvedCardBank,
        cardLast4: resolvedCardLast4,
        payments: nextPayments,
        updatedAt: now,
      });

      if (paymentMethod === 'credito') {
        const baseName = expense.name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
        await this.createCreditCardEntries({
          userId,
          accountTypeId: expense.accountTypeId,
          baseName,
          totalValue: remaining,
          installments: dto.installments!,
          firstInstallmentDate: dto.firstInstallmentDate!,
          sourceExpenseId: expense.id,
          pixKey: expense.pixKey ?? null,
          isAutoDebit: Boolean(expense.isAutoDebit),
          cardBank: resolvedCardBank,
          cardLast4: resolvedCardLast4,
        });
      }

      totalPaid += remaining;
      paidIds.push(expense.id);
    }

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.pay_batch',
      resource: 'expenses',
      outcome: 'ALLOW',
      details: `count=${paidIds.length}`,
    });

    return {
      paidCount: paidIds.length,
      totalPaid: Number(totalPaid.toFixed(2)),
      paymentMethod,
      paidIds,
    };
  }

  async createFoodExpensesBatch(
    userId: string,
    dto: CreateFoodExpensesBatchDto,
  ): Promise<ExpenseWithStatus[]> {
    const accountTypes = await this.firebase.findByField<AccountTypeDoc>(
      COLLECTIONS.ACCOUNT_TYPES,
      'userId',
      userId,
    );
    const typesById = new Map(accountTypes.map((t) => [t.id, t]));

    let defaultFoodCat = accountTypes.find(
      (t) => normalizeOfficialCategory(t.name) === 'Alimentação',
    );
    if (!defaultFoodCat) {
      defaultFoodCat = accountTypes.find(
        (t) => normalizeOfficialCategory(t.name) === 'FastFood',
      );
    }
    if (!defaultFoodCat) {
      const nowCat = new Date().toISOString();
      defaultFoodCat = {
        id: uuidv4(),
        name: 'Alimentação',
        userId,
        createdAt: nowCat,
        updatedAt: nowCat,
      };
      await this.firebase.setDoc(COLLECTIONS.ACCOUNT_TYPES, defaultFoodCat);
      typesById.set(defaultFoodCat.id, defaultFoodCat);
    }

    const now = new Date().toISOString();
    const createdList: ExpenseWithStatus[] = [];

    for (const item of dto.items) {
      const chosenCatId = item.accountTypeId?.trim();
      if (chosenCatId) {
        const cat = typesById.get(chosenCatId);
        if (!cat || cat.userId !== userId) {
          throw new ForbiddenException(
            'Categoria não pertence ao usuário autenticado.',
          );
        }
      }
      const resolvedCat = (chosenCatId && typesById.get(chosenCatId)) || defaultFoodCat;
      const amount = Number(Number(item.amount).toFixed(2));
      const cleanDate = String(item.date).split('T')[0];

      const doc: ExpenseDoc = {
        id: uuidv4(),
        userId,
        accountTypeId: resolvedCat.id,
        name: item.name.trim(),
        value: amount,
        dueDate: cleanDate,
        isRecurring: false,
        isInstallment: false,
        installmentCount: null,
        installmentNumber: null,
        parentExpenseId: null,
        isPaid: true,
        paidAmount: amount,
        discountAmount: 0,
        isEarlyPayment: false,
        paidAt: cleanDate,
        payments: [
          {
            id: uuidv4(),
            amount,
            paidAt: cleanDate,
            paymentMethod: item.paymentMethod,
            createdAt: now,
          },
        ],
        isCreditCard: false,
        paymentMethod: item.paymentMethod,
        createdAt: now,
        updatedAt: now,
      };

      await this.firebase.setDoc(COLLECTIONS.EXPENSES, doc);
      createdList.push(
        this.toExpenseWithStatus(doc, {
          accountType: {
            id: resolvedCat.id,
            name: normalizeOfficialCategory(resolvedCat.name),
          },
          ownerId: userId,
          isOwn: true,
        }),
      );
    }

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.food_batch_create',
      resource: 'expenses',
      outcome: 'ALLOW',
      details: `count=${createdList.length}`,
    });

    return createdList;
  }

  async remove(
    id: string,
    userId: string,
    scope: 'only_month' | 'from_month' | 'all' | 'all_installments' = 'all',
    month?: string,
  ): Promise<void> {
    const expense = await this.firebase.findById<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      id,
    );
    if (!expense || expense.userId !== userId) {
      throw new NotFoundException('Despesa não encontrada');
    }

    const now = new Date().toISOString();

    if (expense.isRecurring && (scope === 'only_month' || scope === 'from_month')) {
      const targetMonth = month || getMonthKeyFromParts(getTodayParts());
      const parsedTarget = parseMonthKey(targetMonth);
      if (!parsedTarget) {
        throw new BadRequestException('Informe um mês válido no formato AAAA-MM.');
      }
      const startParts = parseDateOnly(expense.dueDate);
      const startMonth = getMonthKeyFromParts(startParts);

      if (scope === 'only_month') {
        if (targetMonth < startMonth) {
          throw new BadRequestException(
            'O mês selecionado é anterior ao início desta despesa recorrente.',
          );
        }
        const existingMatId = expense.monthlyOverrides?.[targetMonth]?.materializedExpenseId;
        if (existingMatId) {
          const mat = await this.firebase.findById<ExpenseDoc>(
            COLLECTIONS.EXPENSES,
            existingMatId,
          );
          if (mat && mat.userId === userId) {
            if (mat.receiptPublicId) {
              await this.cloudinaryService?.deleteImage(mat.receiptPublicId);
            }
            await this.firebase.deleteDoc(COLLECTIONS.EXPENSES, mat.id);
          }
        }
        const nextOverrides: Record<string, ExpenseMonthlyOverride> = {
          ...(expense.monthlyOverrides || {}),
          [targetMonth]: {
            ...(expense.monthlyOverrides?.[targetMonth] || {}),
            materializedExpenseId: undefined,
            skipped: true,
          },
        };
        await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, {
          monthlyOverrides: nextOverrides,
          updatedAt: now,
        });
        await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
        return;
      }

      if (targetMonth > startMonth) {
        const endMonth = shiftMonthKey(targetMonth, -1);
        const prunedOverrides: Record<string, ExpenseMonthlyOverride> = {};
        Object.entries(expense.monthlyOverrides || {}).forEach(([mKey, ov]) => {
          if (mKey <= endMonth) {
            prunedOverrides[mKey] = ov;
          }
        });
        await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, {
          recurrenceEndMonth: endMonth,
          monthlyOverrides: prunedOverrides,
          updatedAt: now,
        });
        await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
        return;
      }
    }

    if (scope === 'all_installments' && (expense.isInstallment || expense.parentExpenseId)) {
      const rootId = expense.parentExpenseId || expense.id;
      const allUserExpenses = await this.firebase.findByField<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        userId,
      );
      const groupMembers = allUserExpenses.filter(
        (e) => e.id === rootId || e.parentExpenseId === rootId,
      );
      for (const member of groupMembers) {
        if (member.receiptPublicId) {
          await this.cloudinaryService?.deleteImage(member.receiptPublicId);
        }
        await this.firebase.deleteDoc(COLLECTIONS.EXPENSES, member.id);
      }
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
      void this.auditService?.log({
        actorUserId: userId,
        action: 'expenses.delete_group',
        resource: 'expenses',
        resourceId: rootId,
        outcome: 'ALLOW',
      });
      return;
    }

    if (expense.recurrenceParentId && expense.occurrenceMonth) {
      const parent = await this.firebase.findById<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        expense.recurrenceParentId,
      );
      if (parent && parent.userId === userId) {
        const existingOv = parent.monthlyOverrides?.[expense.occurrenceMonth] || {};
        const nextOverrides: Record<string, ExpenseMonthlyOverride> = {
          ...(parent.monthlyOverrides || {}),
          [expense.occurrenceMonth]: {
            ...existingOv,
            materializedExpenseId: undefined,
            skipped: scope === 'only_month' ? true : existingOv.skipped,
          },
        };
        await this.firebase.updateDoc(COLLECTIONS.EXPENSES, parent.id, {
          monthlyOverrides: nextOverrides,
          updatedAt: now,
        });
      }
    }

    const childExpenses = await this.firebase.findByField<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      'parentExpenseId',
      id,
    );
    for (const child of childExpenses) {
      if (child.userId === userId) {
        if (child.receiptPublicId) {
          await this.cloudinaryService?.deleteImage(child.receiptPublicId);
        }
        await this.firebase.deleteDoc(COLLECTIONS.EXPENSES, child.id);
      }
    }

    if (expense.receiptPublicId) {
      await this.cloudinaryService?.deleteImage(expense.receiptPublicId);
    }

    await this.firebase.deleteDoc(COLLECTIONS.EXPENSES, id);
    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.delete',
      resource: 'expenses',
      resourceId: id,
      outcome: 'ALLOW',
    });
  }

  async uploadReceiptPhoto(
    id: string,
    userId: string,
    file: UploadedImageFile,
  ): Promise<ExpenseWithStatus> {
    const expense = await this.firebase.findById<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      id,
    );
    if (!expense || expense.userId !== userId) {
      throw new NotFoundException('Despesa não encontrada');
    }
    if (!this.cloudinaryService) {
      throw new BadRequestException(
        'Serviço de armazenamento de imagens indisponível.',
      );
    }

    const uploaded = await this.cloudinaryService.uploadImage(
      file,
      'expenses',
      userId,
    );
    const previousPublicId = expense.receiptPublicId || null;
    const now = new Date().toISOString();

    await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, {
      receiptUrl: uploaded.url,
      receiptPublicId: uploaded.publicId,
      updatedAt: now,
    });

    if (previousPublicId && previousPublicId !== uploaded.publicId) {
      await this.cloudinaryService.deleteImage(previousPublicId);
    }

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.photo.update',
      resource: 'expenses',
      resourceId: id,
      outcome: 'ALLOW',
    });

    const updated: ExpenseDoc = {
      ...expense,
      receiptUrl: uploaded.url,
      receiptPublicId: uploaded.publicId,
      updatedAt: now,
    };
    return this.toExpenseWithStatus(updated);
  }

  async getDecryptedReceiptPhoto(
    id: string,
    userId: string,
  ): Promise<DecryptedMediaPayload> {
    const expense = await this.firebase.findById<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      id,
    );
    if (!expense || !expense.receiptUrl) {
      throw new NotFoundException('Comprovante não encontrado.');
    }

    if (expense.userId !== userId) {
      try {
        const authScope = await this.familyService.resolveAuthorizedScope(
          userId,
          'family',
        );
        const canView =
          authScope.userIds.includes(expense.userId) &&
          (authScope.memberPermissions?.get(expense.userId)?.viewExpenses ??
            true);
        if (!canView) {
          throw new ForbiddenException(
            'Sem permissão para visualizar este comprovante.',
          );
        }
      } catch (err) {
        if (err instanceof ForbiddenException) throw err;
        throw new NotFoundException('Comprovante não encontrado.');
      }
    }

    if (!this.cloudinaryService) {
      throw new BadRequestException(
        'Serviço de armazenamento de imagens indisponível.',
      );
    }

    return this.cloudinaryService.downloadAndDecryptImage({
      url: expense.receiptUrl,
      categoryFolder: 'expenses',
      ownerKey: expense.userId,
    });
  }

  async removeReceiptPhoto(
    id: string,
    userId: string,
  ): Promise<ExpenseWithStatus> {
    const expense = await this.firebase.findById<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      id,
    );
    if (!expense || expense.userId !== userId) {
      throw new NotFoundException('Despesa não encontrada');
    }

    const previousPublicId = expense.receiptPublicId || null;
    const now = new Date().toISOString();

    await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, {
      receiptUrl: null,
      receiptPublicId: null,
      updatedAt: now,
    });

    if (previousPublicId) {
      await this.cloudinaryService?.deleteImage(previousPublicId);
    }

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.photo.delete',
      resource: 'expenses',
      resourceId: id,
      outcome: 'ALLOW',
    });

    const updated: ExpenseDoc = {
      ...expense,
      receiptUrl: null,
      receiptPublicId: null,
      updatedAt: now,
    };
    return this.toExpenseWithStatus(updated);
  }

  async update(
    id: string,
    dto: UpdateExpenseDto,
    userId: string,
  ): Promise<ExpenseWithStatus> {
    const expense = await this.firebase.findById<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      id,
    );
    if (!expense || expense.userId !== userId) {
      throw new NotFoundException('Despesa não encontrada');
    }

    if (dto.accountTypeId !== undefined) {
      const targetCategory = await this.firebase.findById<AccountTypeDoc>(
        COLLECTIONS.ACCOUNT_TYPES,
        dto.accountTypeId,
      );
      if (targetCategory && targetCategory.userId !== userId) {
        throw new ForbiddenException(
          'Categoria não pertence ao usuário autenticado.',
        );
      }
    }

    const now = new Date().toISOString();
    const editScope = dto.editScope || 'all';
    const targetMonth = dto.targetMonth || getMonthKeyFromParts(getTodayParts());
    const startParts = parseDateOnly(expense.dueDate);
    const startMonth = getMonthKeyFromParts(startParts);

    if (expense.isRecurring && editScope === 'only_month') {
      const parsedTarget = parseMonthKey(targetMonth);
      if (!parsedTarget) {
        throw new BadRequestException('Informe um mês válido no formato AAAA-MM.');
      }
      if (targetMonth < startMonth) {
        throw new BadRequestException(
          'Não é possível editar um mês anterior ao início desta despesa.',
        );
      }
      if (expense.recurrenceEndMonth && targetMonth > expense.recurrenceEndMonth) {
        throw new BadRequestException(
          'Este mês está após o encerramento desta recorrência.',
        );
      }

      const existingOv = expense.monthlyOverrides?.[targetMonth] || {};
      const nextOverride: ExpenseMonthlyOverride = {
        ...existingOv,
        skipped: false,
      };
      if (dto.name !== undefined) nextOverride.name = dto.name.trim();
      if (dto.value !== undefined) nextOverride.value = Number(dto.value);
      if (dto.accountTypeId !== undefined) {
        nextOverride.accountTypeId = dto.accountTypeId;
      }
      if (dto.dueDate !== undefined) {
        const parsedDue = parseDateOnly(dto.dueDate);
        if (parsedDue.day) nextOverride.day = parsedDue.day;
      }

      const nextOverrides: Record<string, ExpenseMonthlyOverride> = {
        ...(expense.monthlyOverrides || {}),
        [targetMonth]: nextOverride,
      };

      await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, {
        monthlyOverrides: nextOverrides,
        updatedAt: now,
      });

      if (existingOv.materializedExpenseId) {
        const mat = await this.firebase.findById<ExpenseDoc>(
          COLLECTIONS.EXPENSES,
          existingOv.materializedExpenseId,
        );
        if (mat && mat.userId === userId) {
          const matPatch: Partial<ExpenseDoc> = { updatedAt: now };
          if (dto.name !== undefined) matPatch.name = dto.name.trim();
          if (dto.value !== undefined) matPatch.value = Number(dto.value);
          if (dto.accountTypeId !== undefined) {
            matPatch.accountTypeId = dto.accountTypeId;
          }
          if (dto.dueDate !== undefined) matPatch.dueDate = dto.dueDate;
          await this.firebase.updateDoc(COLLECTIONS.EXPENSES, mat.id, matPatch);
        }
      }

      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
      return this.toExpenseWithStatus({
        ...expense,
        monthlyOverrides: nextOverrides,
        updatedAt: now,
      });
    }

    if (expense.isRecurring && editScope === 'from_month' && targetMonth > startMonth) {
      const parsedTarget = parseMonthKey(targetMonth);
      if (!parsedTarget) {
        throw new BadRequestException('Informe um mês válido no formato AAAA-MM.');
      }

      const prevEndMonth = shiftMonthKey(targetMonth, -1);
      const pastOverrides: Record<string, ExpenseMonthlyOverride> = {};
      const futureOverrides: Record<string, ExpenseMonthlyOverride> = {};

      Object.entries(expense.monthlyOverrides || {}).forEach(([mKey, ov]) => {
        if (mKey <= prevEndMonth) {
          pastOverrides[mKey] = ov;
        } else if (mKey > targetMonth) {
          futureOverrides[mKey] = ov;
        }
      });

      const effectiveEndForOld =
        expense.recurrenceEndMonth && expense.recurrenceEndMonth < prevEndMonth
          ? expense.recurrenceEndMonth
          : prevEndMonth;
      const groupId = expense.recurrenceGroupId || expense.id;

      await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, {
        recurrenceEndMonth: effectiveEndForOld,
        recurrenceGroupId: groupId,
        monthlyOverrides: pastOverrides,
        updatedAt: now,
      });

      const dayFromDto = dto.dueDate ? parseDateOnly(dto.dueDate).day : startParts.day;
      const clampedDay = Math.min(
        dayFromDto || startParts.day,
        getDaysInMonth(parsedTarget.year, parsedTarget.month),
      );
      const newDueDate = formatDateOnly({
        year: parsedTarget.year,
        month: parsedTarget.month,
        day: clampedDay,
      });

      const nextSeries: ExpenseDoc = {
        id: uuidv4(),
        userId,
        accountTypeId: dto.accountTypeId ?? expense.accountTypeId,
        name: dto.name !== undefined ? dto.name.trim() : expense.name,
        value: dto.value !== undefined ? Number(dto.value) : Number(expense.value),
        dueDate: newDueDate,
        isRecurring:
          dto.isRecurring !== undefined ? Boolean(dto.isRecurring) : true,
        recurrenceEndMonth: expense.recurrenceEndMonth ?? null,
        recurrenceGroupId: groupId,
        monthlyOverrides: futureOverrides,
        isInstallment: false,
        installmentCount: null,
        installmentNumber: null,
        parentExpenseId: null,
        isPaid: false,
        paidAmount: 0,
        paidAt: null,
        payments: [],
        isCreditCard:
          dto.isCreditCard !== undefined
            ? Boolean(dto.isCreditCard)
            : Boolean(expense.isCreditCard),
        paymentMethod: null,
        pixKey:
          dto.pixKey !== undefined
            ? normalizeOptionalText(dto.pixKey)
            : expense.pixKey ?? null,
        isAutoDebit:
          dto.isAutoDebit !== undefined
            ? Boolean(dto.isAutoDebit)
            : Boolean(expense.isAutoDebit),
        cardBank:
          dto.cardBank !== undefined
            ? normalizeOptionalText(dto.cardBank)
            : expense.cardBank ?? null,
        cardLast4:
          dto.cardLast4 !== undefined
            ? normalizeCardLast4(dto.cardLast4)
            : expense.cardLast4 ?? null,
        createdAt: now,
        updatedAt: now,
      };

      await this.firebase.setDoc(COLLECTIONS.EXPENSES, nextSeries);
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
      return this.toExpenseWithStatus(nextSeries);
    }

    const updateData: Partial<ExpenseDoc> = {
      updatedAt: now,
    };
    if (dto.name !== undefined) updateData.name = dto.name.trim();
    if (dto.accountTypeId !== undefined) {
      updateData.accountTypeId = dto.accountTypeId;
    }
    if (dto.value !== undefined) updateData.value = Number(dto.value);
    if (dto.dueDate !== undefined) updateData.dueDate = dto.dueDate;
    if (dto.isRecurring !== undefined) {
      updateData.isRecurring = Boolean(dto.isRecurring);
    }
    if (dto.isInstallment !== undefined) {
      updateData.isInstallment = Boolean(dto.isInstallment);
    }
    if (dto.installmentCount !== undefined) {
      updateData.installmentCount = dto.installmentCount;
    }
    if (dto.isPaid !== undefined) {
      const nextPaid = Boolean(dto.isPaid);
      updateData.isPaid = nextPaid;
      if (!nextPaid) {
        updateData.paidAmount = 0;
        updateData.paidAt = null;
        updateData.paymentMethod = null;
        updateData.payments = [];
      } else if (!expense.isPaid) {
        const nextVal = Number(updateData.value ?? expense.value);
        const payDate = dto.paidAt || formatDateOnly(getTodayParts());
        const method = (dto.paymentMethod ||
          expense.paymentMethod ||
          'dinheiro') as ExpensePaymentMethod;
        const summary = this.resolveExpensePaymentSummary(expense);
        const remaining = Math.max(0, Number((nextVal - summary.paidAmount).toFixed(2)));
        updateData.paidAmount = nextVal;
        updateData.paidAt = payDate;
        updateData.paymentMethod = method;
        if (remaining > 0.009) {
          updateData.payments = [
            ...summary.payments,
            {
              id: uuidv4(),
              amount: remaining,
              paidAt: payDate,
              paymentMethod: method,
              createdAt: now,
            },
          ];
        }
      }
    }
    if (dto.paidAt !== undefined && updateData.paidAt === undefined) {
      updateData.paidAt = dto.paidAt;
    }
    if (dto.isCreditCard !== undefined) {
      updateData.isCreditCard = Boolean(dto.isCreditCard);
    }
    if (dto.paymentMethod !== undefined) {
      updateData.paymentMethod = dto.paymentMethod;
    }
    if (dto.pixKey !== undefined) {
      updateData.pixKey = normalizeOptionalText(dto.pixKey);
    }
    if (dto.isAutoDebit !== undefined) {
      updateData.isAutoDebit = Boolean(dto.isAutoDebit);
    }
    if (dto.cardBank !== undefined) {
      updateData.cardBank = normalizeOptionalText(dto.cardBank);
    }
    if (dto.cardLast4 !== undefined) {
      updateData.cardLast4 = normalizeCardLast4(dto.cardLast4);
    }

    if (dto.value !== undefined && updateData.isPaid === undefined) {
      const nextValue = Number(dto.value);
      const summary = this.resolveExpensePaymentSummary(expense);
      if (summary.paidAmount > 0 && summary.paidAmount >= nextValue - 0.009) {
        updateData.isPaid = true;
        updateData.paidAmount = nextValue;
      } else if (summary.paidAmount > 0) {
        updateData.isPaid = false;
      }
    }

    await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, updateData);

    const cardMetaChanged =
      dto.cardBank !== undefined ||
      dto.cardLast4 !== undefined ||
      dto.isAutoDebit !== undefined ||
      dto.pixKey !== undefined;

    if (
      (expense.isInstallment || expense.parentExpenseId) &&
      (editScope === 'all_installments' || (cardMetaChanged && editScope !== 'only_month'))
    ) {
      const rootId = expense.parentExpenseId || expense.id;
      const allUserExpenses = await this.firebase.findByField<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        userId,
      );
      const siblings = allUserExpenses.filter(
        (item) =>
          item.id !== expense.id &&
          (item.id === rootId || item.parentExpenseId === rootId),
      );
      const cleanBaseName =
        dto.name !== undefined
          ? dto.name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim()
          : null;

      for (const sib of siblings) {
        const sibPatch: Partial<ExpenseDoc> = { updatedAt: now };
        if (dto.cardBank !== undefined) sibPatch.cardBank = updateData.cardBank;
        if (dto.cardLast4 !== undefined) sibPatch.cardLast4 = updateData.cardLast4;
        if (dto.isAutoDebit !== undefined) sibPatch.isAutoDebit = updateData.isAutoDebit;
        if (dto.pixKey !== undefined) sibPatch.pixKey = updateData.pixKey;

        if (editScope === 'all_installments') {
          if (dto.accountTypeId !== undefined) sibPatch.accountTypeId = dto.accountTypeId;
          if (dto.isCreditCard !== undefined) sibPatch.isCreditCard = updateData.isCreditCard;
          if (cleanBaseName !== null) {
            const suffix =
              sib.installmentNumber && sib.installmentCount
                ? ` (${sib.installmentNumber}/${sib.installmentCount})`
                : '';
            sibPatch.name = `${cleanBaseName}${suffix}`;
          }
          if (dto.value !== undefined && !sib.isPaid) {
            sibPatch.value = Number(dto.value);
          }
        }
        await this.firebase.updateDoc(COLLECTIONS.EXPENSES, sib.id, sibPatch);
      }
    }

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    const updated = { ...expense, ...updateData };
    return this.toExpenseWithStatus(updated);
  }

  async getTotalPaidCurrentMonth(userId: string): Promise<number> {
    const today = getTodayParts();
    const expenses = await this.firebase.findByField<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      'userId',
      userId,
    );

    let total = 0;
    for (const expense of expenses) {
      if (Array.isArray(expense.payments) && expense.payments.length > 0) {
        for (const part of expense.payments) {
          if (part.paymentMethod === 'credito') continue;
          const pDate = parseDateOnly(part.paidAt || expense.dueDate);
          if (pDate.year === today.year && pDate.month === today.month) {
            total += Number(part.amount || 0);
          }
        }
        continue;
      }

      if (expense.paymentMethod === 'credito') continue;
      if (!expense.isPaid && !expense.isRecurring) continue;

      if (expense.isRecurring) {
        const orig = parseDateOnly(expense.dueDate);
        const clampedDay = Math.min(
          orig.day,
          getDaysInMonth(today.year, today.month),
        );
        const currentMonthDue = {
          year: today.year,
          month: today.month,
          day: clampedDay,
        };
        if (compareDateParts(currentMonthDue, today) <= 0) {
          total += this.getEffectiveExpenseValue(expense);
        }
      } else if (expense.isPaid) {
        total += this.getEffectiveExpenseValue(expense);
      }
    }

    return total;
  }
}
