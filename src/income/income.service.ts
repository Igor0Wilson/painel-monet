import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import { BalanceService } from '../balance/balance.service';
import { FamilyService } from '../family/family.service';
import { FirebaseService } from '../firebase/firebase.service';
import { COLLECTIONS, IncomeDoc } from '../firebase/firebase.types';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';
import {
  evaluateIncomeCredit,
  IncomeCreditEvaluation,
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

  async remove(id: string, userId: string): Promise<void> {
    const income = await this.firebase.findById<IncomeDoc>(
      COLLECTIONS.INCOME,
      id,
    );
    if (!income || income.userId !== userId) {
      throw new NotFoundException('Renda não encontrada');
    }
    await this.firebase.deleteDoc(COLLECTIONS.INCOME, id);
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

    const updateData: Partial<IncomeDoc> = {
      updatedAt: new Date().toISOString(),
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
