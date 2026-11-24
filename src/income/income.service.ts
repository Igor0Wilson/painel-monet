import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import { BalanceService } from '../balance/balance.service';
import { FamilyService } from '../family/family.service';
import { FirebaseService } from '../firebase/firebase.service';
import {
  COLLECTIONS,
  IncomeDoc,
  IncomeMonthlyOverride,
} from '../firebase/firebase.types';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';
import {
  evaluateIncomeCredit,
  formatDateOnly,
  getDaysInMonth,
  getMonthKeyFromParts,
  getTodayParts,
  IncomeCreditEvaluation,
  parseDateOnly,
  parseMonthKey,
  shiftMonthKey,
} from './income.date-utils';

export interface IncomeWithEvaluation extends IncomeDoc, IncomeCreditEvaluation {
  ownerId?: string;
  ownerName?: string;
  isOwn?: boolean;
}

@Injectable()
export class IncomeService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly familyService: FamilyService,
    @Optional() private readonly balanceService?: BalanceService,
  ) { }

  async findAll(userId: string, scope?: string): Promise<IncomeWithEvaluation[]> {
    const authScope = await this.familyService.resolveAuthorizedScope(
      userId,
      scope,
    );

    const visibleUserIds =
      authScope.mode === 'family'
        ? authScope.userIds.filter(
            (uid) =>
              uid === userId ||
              (authScope.memberPermissions?.get(uid)?.viewIncome ?? true),
          )
        : authScope.userIds;

    const incomes = await this.firebase.findByFieldIn<IncomeDoc>(
      COLLECTIONS.INCOME,
      'userId',
      visibleUserIds,
    );

    return incomes
      .sort((a, b) => b.incomeDate.localeCompare(a.incomeDate))
      .map((income) => {
        const credit = evaluateIncomeCredit(income);
        const owner = authScope.userMap.get(income.userId);
        return {
          ...income,
          ...credit,
          ownerId: income.userId,
          ownerName: owner?.name || 'Usuário',
          isOwn: income.userId === userId,
        };
      });
  }

  async create(
    dto: CreateIncomeDto,
    userId: string,
  ): Promise<IncomeWithEvaluation> {
    const now = new Date().toISOString();
    const income: IncomeDoc = {
      id: uuidv4(),
      userId,
      name: dto.name.trim(),
      value: Number(dto.value),
      isRecurring: Boolean(dto.isRecurring),
      incomeDate: dto.incomeDate,
      recurrenceEndMonth: null,
      recurrenceGroupId: null,
      monthlyOverrides: {},
      createdAt: now,
      updatedAt: now,
    };

    await this.firebase.setDoc(COLLECTIONS.INCOME, income);
    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    return {
      ...income,
      ...evaluateIncomeCredit(income),
    };
  }

  async remove(
    id: string,
    userId: string,
    scope: 'only_month' | 'from_month' | 'all' = 'all',
    month?: string,
  ): Promise<void> {
    const income = await this.firebase.findById<IncomeDoc>(
      COLLECTIONS.INCOME,
      id,
    );
    if (!income || income.userId !== userId) {
      throw new NotFoundException('Renda não encontrada');
    }

    if (!income.isRecurring || scope === 'all') {
      await this.firebase.deleteDoc(COLLECTIONS.INCOME, id);
      await this.balanceService?.reconcileSavingsOnIncomeChange(userId);
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
      return;
    }

    const targetMonth = month || getMonthKeyFromParts(getTodayParts());
    const parsedTarget = parseMonthKey(targetMonth);
    if (!parsedTarget) {
      throw new BadRequestException('Informe um mês válido no formato AAAA-MM.');
    }

    const startParts = parseDateOnly(income.incomeDate);
    const startMonth = getMonthKeyFromParts(startParts);
    const now = new Date().toISOString();

    if (scope === 'only_month') {
      if (targetMonth < startMonth) {
        throw new BadRequestException(
          'O mês selecionado é anterior ao início desta receita recorrente.',
        );
      }
      const nextOverrides: Record<string, IncomeMonthlyOverride> = {
        ...(income.monthlyOverrides || {}),
        [targetMonth]: {
          ...(income.monthlyOverrides?.[targetMonth] || {}),
          skipped: true,
        },
      };
      await this.firebase.updateDoc(COLLECTIONS.INCOME, id, {
        monthlyOverrides: nextOverrides,
        updatedAt: now,
      });
    } else if (scope === 'from_month') {
      if (targetMonth <= startMonth) {
        await this.firebase.deleteDoc(COLLECTIONS.INCOME, id);
      } else {
        const endMonth = shiftMonthKey(targetMonth, -1);
        const prunedOverrides: Record<string, IncomeMonthlyOverride> = {};
        Object.entries(income.monthlyOverrides || {}).forEach(([mKey, ov]) => {
          if (mKey <= endMonth) {
            prunedOverrides[mKey] = ov;
          }
        });
        await this.firebase.updateDoc(COLLECTIONS.INCOME, id, {
          recurrenceEndMonth: endMonth,
          monthlyOverrides: prunedOverrides,
          updatedAt: now,
        });
      }
    }

    await this.balanceService?.reconcileSavingsOnIncomeChange(userId);
    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
  }

  async update(
    id: string,
    dto: UpdateIncomeDto,
    userId: string,
  ): Promise<IncomeWithEvaluation> {
    const income = await this.firebase.findById<IncomeDoc>(
      COLLECTIONS.INCOME,
      id,
    );
    if (!income || income.userId !== userId) {
      throw new NotFoundException('Renda não encontrada');
    }

    const editScope = dto.editScope || 'all';
    const targetMonth = dto.targetMonth || getMonthKeyFromParts(getTodayParts());
    const startParts = parseDateOnly(income.incomeDate);
    const startMonth = getMonthKeyFromParts(startParts);
    const now = new Date().toISOString();

    if (income.isRecurring && editScope === 'only_month') {
      const parsedTarget = parseMonthKey(targetMonth);
      if (!parsedTarget) {
        throw new BadRequestException('Informe um mês válido no formato AAAA-MM.');
      }
      if (targetMonth < startMonth) {
        throw new BadRequestException(
          'Não é possível editar um mês anterior ao início desta receita.',
        );
      }
      if (income.recurrenceEndMonth && targetMonth > income.recurrenceEndMonth) {
        throw new BadRequestException(
          'Este mês está após o encerramento desta recorrência.',
        );
      }

      const existingOv = income.monthlyOverrides?.[targetMonth] || {};
      const nextOverride: IncomeMonthlyOverride = {
        ...existingOv,
        skipped: false,
      };
      if (dto.value !== undefined) nextOverride.value = Number(dto.value);
      if (dto.name !== undefined) nextOverride.name = dto.name.trim();
      if (dto.incomeDate !== undefined) {
        const parsedInputDate = parseDateOnly(dto.incomeDate);
        if (parsedInputDate.day) {
          nextOverride.day = parsedInputDate.day;
        }
      }

      const nextOverrides: Record<string, IncomeMonthlyOverride> = {
        ...(income.monthlyOverrides || {}),
        [targetMonth]: nextOverride,
      };

      await this.firebase.updateDoc(COLLECTIONS.INCOME, id, {
        monthlyOverrides: nextOverrides,
        updatedAt: now,
      });
      await this.balanceService?.reconcileSavingsOnIncomeChange(userId);
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

      const updated: IncomeDoc = {
        ...income,
        monthlyOverrides: nextOverrides,
        updatedAt: now,
      };
      return {
        ...updated,
        ...evaluateIncomeCredit(updated),
      };
    }

    if (income.isRecurring && editScope === 'from_month' && targetMonth > startMonth) {
      const parsedTarget = parseMonthKey(targetMonth);
      if (!parsedTarget) {
        throw new BadRequestException('Informe um mês válido no formato AAAA-MM.');
      }
      const prevEndMonth = shiftMonthKey(targetMonth, -1);
      const pastOverrides: Record<string, IncomeMonthlyOverride> = {};
      const futureOverrides: Record<string, IncomeMonthlyOverride> = {};

      Object.entries(income.monthlyOverrides || {}).forEach(([mKey, ov]) => {
        if (mKey <= prevEndMonth) {
          pastOverrides[mKey] = ov;
        } else if (mKey > targetMonth) {
          futureOverrides[mKey] = ov;
        }
      });

      const effectiveEndForOld =
        income.recurrenceEndMonth && income.recurrenceEndMonth < prevEndMonth
          ? income.recurrenceEndMonth
          : prevEndMonth;

      const groupId = income.recurrenceGroupId || income.id;
      await this.firebase.updateDoc(COLLECTIONS.INCOME, id, {
        recurrenceEndMonth: effectiveEndForOld,
        recurrenceGroupId: groupId,
        monthlyOverrides: pastOverrides,
        updatedAt: now,
      });

      const dayFromDto = dto.incomeDate ? parseDateOnly(dto.incomeDate).day : startParts.day;
      const clampedDay = Math.min(
        dayFromDto || startParts.day,
        getDaysInMonth(parsedTarget.year, parsedTarget.month),
      );
      const newIncomeDate = formatDateOnly({
        year: parsedTarget.year,
        month: parsedTarget.month,
        day: clampedDay,
      });

      const nextSeries: IncomeDoc = {
        id: uuidv4(),
        userId,
        name: dto.name !== undefined ? dto.name.trim() : income.name,
        value: dto.value !== undefined ? Number(dto.value) : Number(income.value),
        isRecurring:
          dto.isRecurring !== undefined ? Boolean(dto.isRecurring) : true,
        incomeDate: newIncomeDate,
        recurrenceEndMonth: income.recurrenceEndMonth ?? null,
        recurrenceGroupId: groupId,
        monthlyOverrides: futureOverrides,
        createdAt: now,
        updatedAt: now,
      };

      await this.firebase.setDoc(COLLECTIONS.INCOME, nextSeries);
      await this.balanceService?.reconcileSavingsOnIncomeChange(userId);
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

      return {
        ...nextSeries,
        ...evaluateIncomeCredit(nextSeries),
      };
    }

    const updateData: Partial<IncomeDoc> = {
      updatedAt: now,
    };
    if (dto.name !== undefined) updateData.name = dto.name.trim();
    if (dto.value !== undefined) updateData.value = Number(dto.value);
    if (dto.isRecurring !== undefined) {
      updateData.isRecurring = Boolean(dto.isRecurring);
    }
    if (dto.incomeDate !== undefined) updateData.incomeDate = dto.incomeDate;

    await this.firebase.updateDoc(COLLECTIONS.INCOME, id, updateData);
    await this.balanceService?.reconcileSavingsOnIncomeChange(userId);
    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    const updated = { ...income, ...updateData };
    return {
      ...updated,
      ...evaluateIncomeCredit(updated),
    };
  }

  async getTotalIncome(userId: string): Promise<number> {
    const incomes = await this.firebase.findByField<IncomeDoc>(
      COLLECTIONS.INCOME,
      'userId',
      userId,
    );
    const total = incomes.reduce(
      (acc, income) => acc + evaluateIncomeCredit(income).creditedAmount,
      0,
    );
    return Number(total.toFixed(2));
  }
}
