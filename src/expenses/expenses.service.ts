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
  CloudinaryService,
  type UploadedImageFile,
} from '../common/cloudinary.service';
import { FamilyService } from '../family/family.service';
import { FirebaseService } from '../firebase/firebase.service';
import {
  AccountTypeDoc,
  COLLECTIONS,
  ExpenseDoc,
} from '../firebase/firebase.types';
import {
  addMonthsDateOnly,
  compareDateParts,
  getDaysInMonth,
  getTodayParts,
  parseDateOnly,
} from '../income/income.date-utils';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { PayCreditCardInvoiceDto } from './dto/pay-credit-card-invoice.dto';
import { PayExpenseDto } from './dto/pay-expense.dto';
import { PayExpensesBatchDto } from './dto/pay-expenses-batch.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';

export type ExpenseStatus = 'pago' | 'em_atraso' | 'pendente';

export interface ExpenseWithStatus extends ExpenseDoc {
  status: ExpenseStatus;
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
      const clampedDay = Math.min(
        dueParts.day,
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

  private async createCreditCardEntries(params: {
    userId: string;
    accountTypeId: string;
    baseName: string;
    totalValue: number;
    installments: number;
    firstInstallmentDate: string;
  }): Promise<ExpenseWithStatus[]> {
    const {
      userId,
      accountTypeId,
      baseName,
      totalValue,
      installments,
      firstInstallmentDate,
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
        isPaid: false,
        isCreditCard: true,
        paymentMethod: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.firebase.setDoc(COLLECTIONS.EXPENSES, singleBill);
      created.push({
        ...singleBill,
        status: this.calcularStatus(singleBill),
      });
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
          isPaid: false,
          isCreditCard: true,
          paymentMethod: null,
          createdAt: now,
          updatedAt: now,
        };
        await this.firebase.setDoc(COLLECTIONS.EXPENSES, parcela);
        created.push({
          ...parcela,
          status: this.calcularStatus(parcela),
        });
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
        return {
          ...e,
          accountType: {
            id: accountType?.id || e.accountTypeId || 'diversos',
            name: normalizedCategoryName,
          },
          isCreditCard:
            Boolean(e.isCreditCard) ||
            isCreditCardCategoryName(accountType?.name),
          status: this.calcularStatus(e),
          ownerId: e.userId,
          ownerName: owner?.name || 'Usuário',
          isOwn: e.userId === userId,
        };
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

    let result: ExpenseWithStatus | ExpenseWithStatus[];

    if (dto.paymentMethod === 'credito') {
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
      const isPaid = dto.isPaid ?? Boolean(dto.paymentMethod);
      const resolvedPaymentMethod = isPaid
        ? dto.paymentMethod || 'dinheiro'
        : null;
      const now = new Date().toISOString();

      const expense: ExpenseDoc = {
        id: uuidv4(),
        name: dto.name.trim(),
        accountTypeId: dto.accountTypeId,
        value: Number(dto.value),
        dueDate: dto.dueDate,
        isRecurring: Boolean(dto.isRecurring),
        isInstallment: false,
        installmentCount: null,
        installmentNumber: null,
        parentExpenseId: null,
        userId,
        isPaid,
        isCreditCard: Boolean(dto.isCreditCard || isCardCategory),
        paymentMethod: resolvedPaymentMethod,
        createdAt: now,
        updatedAt: now,
      };

      await this.firebase.setDoc(COLLECTIONS.EXPENSES, expense);
      result = { ...expense, status: this.calcularStatus(expense) };
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
        isCreditCard,
        paymentMethod: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.firebase.setDoc(COLLECTIONS.EXPENSES, parcela);
      parcelas.push({
        ...parcela,
        status: this.calcularStatus(parcela),
      });
    }

    return parcelas;
  }

  async markAsPaid(
    id: string,
    userId: string,
    dto?: PayExpenseDto,
  ): Promise<ExpenseWithStatus> {
    const expense = await this.firebase.findById<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      id,
    );
    if (!expense || expense.userId !== userId) {
      throw new NotFoundException('Despesa não encontrada');
    }
    if (expense.isPaid) {
      throw new BadRequestException('Esta despesa já foi liquidada');
    }

    const paymentMethod = dto?.paymentMethod || 'dinheiro';
    const now = new Date().toISOString();

    if (paymentMethod !== 'credito') {
      await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, {
        isPaid: true,
        paymentMethod,
        updatedAt: now,
      });
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

      return {
        ...expense,
        isPaid: true,
        paymentMethod,
        updatedAt: now,
        status: 'pago',
        generatedInstallments: [],
      };
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

    await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, {
      isPaid: true,
      paymentMethod: 'credito',
      updatedAt: now,
    });

    const baseName = expense.name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
    const generatedInstallments = await this.createCreditCardEntries({
      userId,
      accountTypeId: expense.accountTypeId,
      baseName,
      totalValue: Number(expense.value),
      installments,
      firstInstallmentDate,
    });

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'expenses.pay',
      resource: 'expenses',
      resourceId: expense.id,
      outcome: 'ALLOW',
    });

    return {
      ...expense,
      isPaid: true,
      paymentMethod: 'credito',
      updatedAt: now,
      status: 'pago',
      generatedInstallments,
    };
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
      return isCard && dueStr.startsWith(dto.month);
    });

    if (matching.length === 0) {
      throw new NotFoundException(
        'Nenhuma compra ou parcela em aberto no cartão de crédito para este mês.',
      );
    }

    const now = new Date().toISOString();
    let totalPaid = 0;
    const paidIds: string[] = [];

    for (const exp of matching) {
      await this.firebase.updateDoc(COLLECTIONS.EXPENSES, exp.id, {
        isPaid: true,
        paymentMethod,
        updatedAt: now,
      });
      totalPaid += Number(exp.value);
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
    let totalPaid = 0;
    const paidIds: string[] = [];

    for (const expense of targets) {
      await this.firebase.updateDoc(COLLECTIONS.EXPENSES, expense.id, {
        isPaid: true,
        paymentMethod,
        updatedAt: now,
      });

      if (paymentMethod === 'credito') {
        const baseName = expense.name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
        await this.createCreditCardEntries({
          userId,
          accountTypeId: expense.accountTypeId,
          baseName,
          totalValue: Number(expense.value),
          installments: dto.installments!,
          firstInstallmentDate: dto.firstInstallmentDate!,
        });
      }

      totalPaid += Number(expense.value);
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

  async remove(id: string, userId: string): Promise<void> {
    const expense = await this.firebase.findById<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      id,
    );
    if (!expense || expense.userId !== userId) {
      throw new NotFoundException('Despesa não encontrada');
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
    return { ...updated, status: this.calcularStatus(updated) };
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
    return { ...updated, status: this.calcularStatus(updated) };
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

    const updateData: Partial<ExpenseDoc> = {
      updatedAt: new Date().toISOString(),
    };
    if (dto.name !== undefined) updateData.name = dto.name.trim();
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
    if (dto.isPaid !== undefined) updateData.isPaid = Boolean(dto.isPaid);
    if (dto.isCreditCard !== undefined) {
      updateData.isCreditCard = Boolean(dto.isCreditCard);
    }
    if (dto.paymentMethod !== undefined) {
      updateData.paymentMethod = dto.paymentMethod;
    }

    await this.firebase.updateDoc(COLLECTIONS.EXPENSES, id, updateData);
    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    const updated = { ...expense, ...updateData };
    return { ...updated, status: this.calcularStatus(updated) };
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
          total += Number(expense.value);
        }
      } else if (expense.isPaid) {
        total += Number(expense.value);
      }
    }

    return total;
  }
}
