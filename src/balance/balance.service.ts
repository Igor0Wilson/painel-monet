import { BadRequestException, Injectable } from '@nestjs/common';
import { normalizeOfficialCategory } from '../account-types/account-types.service';
import { FamilyService } from '../family/family.service';
import { FirebaseService } from '../firebase/firebase.service';
import {
  AccountTypeDoc,
  COLLECTIONS,
  ExpenseDoc,
  IncomeDoc,
  UserDoc,
} from '../firebase/firebase.types';
import {
  compareDateParts,
  evaluateIncomeCredit,
  formatDateOnly,
  getDaysInMonth,
  getTodayParts,
  parseDateOnly,
} from '../income/income.date-utils';

@Injectable()
export class BalanceService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly familyService: FamilyService,
  ) {}

  private computeCashAndIncome(
    userIncomes: IncomeDoc[],
    userExpenses: ExpenseDoc[],
    today = getTodayParts(),
  ) {
    let totalIncome = 0;
    let scheduledIncome = 0;

    for (const curr of userIncomes) {
      const credit = evaluateIncomeCredit(curr, today);
      totalIncome += credit.creditedAmount;
      scheduledIncome += credit.scheduledAmount;
    }

    let cashExpenses = 0;
    let foodAllowanceUsed = 0;

    for (const curr of userExpenses) {
      if (!curr.isPaid || curr.paymentMethod === 'credito') continue;
      const val = Number(curr.value);
      if (curr.paymentMethod === 'va' || curr.paymentMethod === 'vr') {
        foodAllowanceUsed += val;
      } else {
        cashExpenses += val;
      }
    }

    return {
      totalIncome,
      scheduledIncome,
      cashExpenses,
      foodAllowanceUsed,
    };
  }

  private computeUncoveredShift(user: UserDoc, operatingCash: number) {
    const allocRes = Number(user.emergencyFund || 0);
    const extRes = Number(user.externalEmergencyFund || 0);
    const allocInv = Number(user.investments || 0);
    const extInv = Number(user.externalInvestments || 0);

    const safeOperating = Math.max(0, Number(operatingCash.toFixed(2)));
    const excess = Number((allocInv + allocRes - safeOperating).toFixed(2));
    if (excess <= 0.001) {
      return null;
    }

    const moveInv = Math.min(allocInv, excess);
    const remExcess = Number((excess - moveInv).toFixed(2));
    const moveRes = Math.min(allocRes, remExcess);

    return {
      investments: Number((allocInv - moveInv).toFixed(2)),
      externalInvestments: Number((extInv + moveInv).toFixed(2)),
      emergencyFund: Number((allocRes - moveRes).toFixed(2)),
      externalEmergencyFund: Number((extRes + moveRes).toFixed(2)),
    };
  }

  private computeUserMetrics(
    user: UserDoc,
    userIncomes: IncomeDoc[],
    userExpenses: ExpenseDoc[],
    today = getTodayParts(),
  ) {
    const { totalIncome, scheduledIncome, cashExpenses, foodAllowanceUsed } =
      this.computeCashAndIncome(userIncomes, userExpenses, today);

    const totalExpenses = cashExpenses + foodAllowanceUsed;
    const allocatedEmergencyFund = Number(user.emergencyFund || 0);
    const externalEmergencyFund = Number(user.externalEmergencyFund || 0);
    const emergencyFund = allocatedEmergencyFund + externalEmergencyFund;
    const allocatedInvestments = Number(user.investments || 0);
    const externalInvestments = Number(user.externalInvestments || 0);
    const investments = allocatedInvestments + externalInvestments;
    const foodAllowanceConfigured = Number(user.foodAllowance || 0);
    const foodAllowanceDate = user.foodAllowanceDate || formatDateOnly(today);
    const foodAllowanceRecurring =
      user.foodAllowanceRecurring !== undefined
        ? Boolean(user.foodAllowanceRecurring)
        : true;

    let foodAllowanceTotal = 0;
    let foodAllowanceScheduled = 0;
    let foodAllowanceNextDate: string | null = null;

    if (foodAllowanceConfigured > 0) {
      const foodEval = evaluateIncomeCredit(
        {
          value: foodAllowanceConfigured,
          incomeDate: foodAllowanceDate,
          isRecurring: foodAllowanceRecurring,
        },
        today,
      );
      foodAllowanceTotal = foodEval.creditedAmount;
      foodAllowanceScheduled = foodEval.scheduledAmount;
      foodAllowanceNextDate = foodEval.nextCreditDate || foodAllowanceDate;
    }

    const foodAllowance = Math.max(
      0,
      Number((foodAllowanceTotal - foodAllowanceUsed).toFixed(2)),
    );
    const balance =
      totalIncome -
      cashExpenses -
      allocatedEmergencyFund -
      allocatedInvestments;

    return {
      balance: Number(balance.toFixed(2)),
      totalIncome: Number(totalIncome.toFixed(2)),
      scheduledIncome: Number(scheduledIncome.toFixed(2)),
      totalExpenses: Number(totalExpenses.toFixed(2)),
      emergencyFund: Number(emergencyFund.toFixed(2)),
      allocatedEmergencyFund: Number(allocatedEmergencyFund.toFixed(2)),
      externalEmergencyFund: Number(externalEmergencyFund.toFixed(2)),
      investments: Number(investments.toFixed(2)),
      allocatedInvestments: Number(allocatedInvestments.toFixed(2)),
      externalInvestments: Number(externalInvestments.toFixed(2)),
      foodAllowance: Number(foodAllowance.toFixed(2)),
      foodAllowanceTotal: Number(foodAllowanceTotal.toFixed(2)),
      foodAllowanceConfigured: Number(foodAllowanceConfigured.toFixed(2)),
      foodAllowanceScheduled: Number(foodAllowanceScheduled.toFixed(2)),
      foodAllowanceUsed: Number(foodAllowanceUsed.toFixed(2)),
      foodAllowanceDate,
      foodAllowanceRecurring,
      foodAllowanceNextDate,
    };
  }

  async getBalance(userId: string, scope?: string) {
    const today = getTodayParts();
    const authScope = await this.familyService.resolveAuthorizedScope(
      userId,
      scope,
    );

    const [users, incomes, expenses] = await Promise.all([
      this.firebase.findByFieldIn<UserDoc>(
        COLLECTIONS.USERS,
        'id',
        authScope.userIds,
      ),
      this.firebase.findByFieldIn<IncomeDoc>(
        COLLECTIONS.INCOME,
        'userId',
        authScope.userIds,
      ),
      this.firebase.findByFieldIn<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        authScope.userIds,
      ),
    ]);

    const memberBreakdown = await Promise.all(
      users.map(async (u) => {
        const uIncomes = incomes.filter((i) => i.userId === u.id);
        const uExpenses = expenses.filter((e) => e.userId === u.id);

        let effectiveUser = u;
        const isLegacySavingsUser =
          u.externalInvestments === undefined ||
          u.externalEmergencyFund === undefined;

        if (isLegacySavingsUser) {
          const { totalIncome, cashExpenses } = this.computeCashAndIncome(
            uIncomes,
            uExpenses,
            today,
          );
          const shift = this.computeUncoveredShift(
            u,
            totalIncome - cashExpenses,
          );
          if (shift) {
            await this.firebase.updateDoc(COLLECTIONS.USERS, u.id, {
              ...shift,
              updatedAt: new Date().toISOString(),
            });
            effectiveUser = { ...u, ...shift };
          }
        }

        const metrics = this.computeUserMetrics(
          effectiveUser,
          uIncomes,
          uExpenses,
          today,
        );
        const info = authScope.userMap.get(u.id);
        return {
          userId: u.id,
          name: u.name,
          maskedCpf: info?.maskedCpf || '***.***.***-**',
          phone: u.phone || null,
          isSelf: u.id === userId,
          ...metrics,
        };
      }),
    );

    const totals = memberBreakdown.reduce(
      (acc, m) => ({
        balance: acc.balance + m.balance,
        totalIncome: acc.totalIncome + m.totalIncome,
        scheduledIncome: acc.scheduledIncome + m.scheduledIncome,
        totalExpenses: acc.totalExpenses + m.totalExpenses,
        emergencyFund: acc.emergencyFund + m.emergencyFund,
        allocatedEmergencyFund:
          acc.allocatedEmergencyFund + m.allocatedEmergencyFund,
        externalEmergencyFund:
          acc.externalEmergencyFund + m.externalEmergencyFund,
        investments: acc.investments + m.investments,
        allocatedInvestments: acc.allocatedInvestments + m.allocatedInvestments,
        externalInvestments: acc.externalInvestments + m.externalInvestments,
        foodAllowance: acc.foodAllowance + m.foodAllowance,
        foodAllowanceTotal: acc.foodAllowanceTotal + m.foodAllowanceTotal,
        foodAllowanceScheduled:
          acc.foodAllowanceScheduled + m.foodAllowanceScheduled,
        foodAllowanceUsed: acc.foodAllowanceUsed + m.foodAllowanceUsed,
      }),
      {
        balance: 0,
        totalIncome: 0,
        scheduledIncome: 0,
        totalExpenses: 0,
        emergencyFund: 0,
        allocatedEmergencyFund: 0,
        externalEmergencyFund: 0,
        investments: 0,
        allocatedInvestments: 0,
        externalInvestments: 0,
        foodAllowance: 0,
        foodAllowanceTotal: 0,
        foodAllowanceScheduled: 0,
        foodAllowanceUsed: 0,
      },
    );

    const selfMetrics = memberBreakdown.find((m) => m.isSelf);

    return {
      scope: authScope.mode,
      balance: Number(totals.balance.toFixed(2)),
      totalIncome: Number(totals.totalIncome.toFixed(2)),
      scheduledIncome: Number(totals.scheduledIncome.toFixed(2)),
      totalExpenses: Number(totals.totalExpenses.toFixed(2)),
      emergencyFund: Number(totals.emergencyFund.toFixed(2)),
      allocatedEmergencyFund: Number(totals.allocatedEmergencyFund.toFixed(2)),
      externalEmergencyFund: Number(totals.externalEmergencyFund.toFixed(2)),
      investments: Number(totals.investments.toFixed(2)),
      allocatedInvestments: Number(totals.allocatedInvestments.toFixed(2)),
      externalInvestments: Number(totals.externalInvestments.toFixed(2)),
      foodAllowance: Number(totals.foodAllowance.toFixed(2)),
      foodAllowanceTotal: Number(totals.foodAllowanceTotal.toFixed(2)),
      foodAllowanceScheduled: Number(totals.foodAllowanceScheduled.toFixed(2)),
      foodAllowanceUsed: Number(totals.foodAllowanceUsed.toFixed(2)),
      ownBalance: selfMetrics?.balance ?? 0,
      ownEmergencyFund: selfMetrics?.emergencyFund ?? 0,
      ownAllocatedEmergencyFund: selfMetrics?.allocatedEmergencyFund ?? 0,
      ownExternalEmergencyFund: selfMetrics?.externalEmergencyFund ?? 0,
      ownInvestments: selfMetrics?.investments ?? 0,
      ownAllocatedInvestments: selfMetrics?.allocatedInvestments ?? 0,
      ownExternalInvestments: selfMetrics?.externalInvestments ?? 0,
      ownFoodAllowance: selfMetrics?.foodAllowance ?? 0,
      ownFoodAllowanceTotal: selfMetrics?.foodAllowanceTotal ?? 0,
      ownFoodAllowanceConfigured: selfMetrics?.foodAllowanceConfigured ?? 0,
      ownFoodAllowanceScheduled: selfMetrics?.foodAllowanceScheduled ?? 0,
      ownFoodAllowanceUsed: selfMetrics?.foodAllowanceUsed ?? 0,
      ownFoodAllowanceDate: selfMetrics?.foodAllowanceDate ?? null,
      ownFoodAllowanceRecurring: selfMetrics?.foodAllowanceRecurring ?? true,
      ownFoodAllowanceNextDate: selfMetrics?.foodAllowanceNextDate ?? null,
      memberBreakdown,
    };
  }

  async reconcileSavingsOnIncomeChange(userId: string): Promise<void> {
    const [user, userIncomes, userExpenses] = await Promise.all([
      this.firebase.findById<UserDoc>(COLLECTIONS.USERS, userId),
      this.firebase.findByField<IncomeDoc>(COLLECTIONS.INCOME, 'userId', userId),
      this.firebase.findByField<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        userId,
      ),
    ]);
    if (!user) return;

    const { totalIncome, cashExpenses } = this.computeCashAndIncome(
      userIncomes,
      userExpenses,
    );
    const shift = this.computeUncoveredShift(user, totalIncome - cashExpenses);
    if (!shift) return;

    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      ...shift,
      updatedAt: new Date().toISOString(),
    });
  }

  private async updateSavingsBucket(params: {
    userId: string;
    amount: number;
    fromAvailableBalance: boolean;
    reclassifyAllocatedToExternal: boolean;
    allocatedField: 'emergencyFund' | 'investments';
    externalField: 'externalEmergencyFund' | 'externalInvestments';
    negativeErrorMessage: string;
    exceedErrorMessage: string;
  }) {
    const {
      userId,
      amount,
      fromAvailableBalance,
      reclassifyAllocatedToExternal,
      allocatedField,
      externalField,
      negativeErrorMessage,
      exceedErrorMessage,
    } = params;

    if (amount < 0) {
      throw new BadRequestException(negativeErrorMessage);
    }

    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (user) {
      const now = new Date().toISOString();
      if (reclassifyAllocatedToExternal) {
        const currentAlloc = Number(user[allocatedField] || 0);
        const currentExt = Number(user[externalField] || 0);
        await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
          [allocatedField]: 0,
          [externalField]: Number((currentExt + currentAlloc).toFixed(2)),
          updatedAt: now,
        });
      } else if (fromAvailableBalance) {
        const current = await this.getBalance(userId, 'individual');
        const currentAlloc =
          allocatedField === 'emergencyFund'
            ? current.ownAllocatedEmergencyFund
            : current.ownAllocatedInvestments;
        const maxAllowed = Number(
          (current.ownBalance + currentAlloc).toFixed(2),
        );
        if (amount > currentAlloc + 0.001 && amount > maxAllowed + 0.001) {
          throw new BadRequestException(exceedErrorMessage);
        }
        await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
          [allocatedField]: Number(amount),
          updatedAt: now,
        });
      } else {
        await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
          [externalField]: Number(amount),
          updatedAt: now,
        });
      }
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    }

    return this.getBalance(userId, 'individual');
  }

  async updateEmergencyFund(
    userId: string,
    amount: number,
    fromAvailableBalance = true,
    reclassifyAllocatedToExternal = false,
  ) {
    return this.updateSavingsBucket({
      userId,
      amount,
      fromAvailableBalance,
      reclassifyAllocatedToExternal,
      allocatedField: 'emergencyFund',
      externalField: 'externalEmergencyFund',
      negativeErrorMessage: 'O valor da reserva não pode ser negativo.',
      exceedErrorMessage:
        'A reserva de emergência alocada do saldo não pode exceder o seu patrimônio disponível. Para registrar reserva já existente, selecione "Já existente".',
    });
  }

  async updateInvestments(
    userId: string,
    amount: number,
    fromAvailableBalance = true,
    reclassifyAllocatedToExternal = false,
  ) {
    return this.updateSavingsBucket({
      userId,
      amount,
      fromAvailableBalance,
      reclassifyAllocatedToExternal,
      allocatedField: 'investments',
      externalField: 'externalInvestments',
      negativeErrorMessage: 'O valor em investimentos não pode ser negativo.',
      exceedErrorMessage:
        'O valor em investimentos descontado do saldo do mês não pode exceder o seu patrimônio disponível. Para registrar investimentos já existentes, selecione "Carteira já existente".',
    });
  }

  async updateFoodAllowance(
    userId: string,
    amount: number,
    creditDate?: string,
    isRecurring?: boolean,
  ) {
    if (amount < 0) {
      throw new BadRequestException(
        'O valor do Vale Alimentação/Refeição não pode ser negativo.',
      );
    }
    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (user) {
      const todayIso = formatDateOnly(getTodayParts());
      await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
        foodAllowance: Number(amount),
        foodAllowanceDate: creditDate || user.foodAllowanceDate || todayIso,
        foodAllowanceRecurring:
          isRecurring !== undefined
            ? Boolean(isRecurring)
            : (user.foodAllowanceRecurring ?? true),
        updatedAt: new Date().toISOString(),
      });
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    }
    return this.getBalance(userId, 'individual');
  }

  private resolveMonthParam(month?: string): {
    monthKey: string;
    year: number;
    monthNum: number;
  } {
    const today = getTodayParts();
    if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      return { monthKey: month, year: y, monthNum: m };
    }
    const mm = String(today.month).padStart(2, '0');
    return {
      monthKey: `${today.year}-${mm}`,
      year: today.year,
      monthNum: today.month,
    };
  }

  async getChartData(userId: string, month?: string, scope?: string) {
    const today = getTodayParts();
    const { monthKey, year, monthNum } = this.resolveMonthParam(month);
    const authScope = await this.familyService.resolveAuthorizedScope(
      userId,
      scope,
    );

    const [expenses, incomes, accountTypes] = await Promise.all([
      this.firebase.findByFieldIn<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        authScope.userIds,
      ),
      this.firebase.findByFieldIn<IncomeDoc>(
        COLLECTIONS.INCOME,
        'userId',
        authScope.userIds,
      ),
      this.firebase.findByFieldIn<AccountTypeDoc>(
        COLLECTIONS.ACCOUNT_TYPES,
        'userId',
        authScope.userIds,
      ),
    ]);

    const typesById = new Map(accountTypes.map((t) => [t.id, t]));

    const monthsSet = new Set<string>([
      `${today.year}-${String(today.month).padStart(2, '0')}`,
      monthKey,
    ]);
    expenses.forEach((e) => {
      if (e.dueDate) monthsSet.add(String(e.dueDate).slice(0, 7));
    });
    incomes.forEach((inc) => {
      if (inc.incomeDate) monthsSet.add(String(inc.incomeDate).slice(0, 7));
    });
    const availableMonths = Array.from(monthsSet).sort((a, b) =>
      b.localeCompare(a),
    );

    const daysInMonth = getDaysInMonth(year, monthNum);
    const categoryMap = new Map<string, number>();
    let monthTotalExpenses = 0;
    const dailyExpenseMap = new Map<number, number>();
    const targetMonthIdx = year * 12 + (monthNum - 1);

    expenses.forEach((e) => {
      if (e.paymentMethod === 'credito' && !e.isCreditCard) return;
      const d = parseDateOnly(e.dueDate);
      const expMonthIdx = d.year * 12 + (d.month - 1);

      const isSameMonth = d.year === year && d.month === monthNum;
      const isRecurringInMonth =
        Boolean(e.isRecurring) && targetMonthIdx >= expMonthIdx;

      if (!isSameMonth && !isRecurringInMonth) return;

      const val = Number(e.value);
      const rawCatName = typesById.get(e.accountTypeId)?.name;
      const catName = normalizeOfficialCategory(rawCatName);
      categoryMap.set(catName, (categoryMap.get(catName) || 0) + val);

      if (e.isPaid && isSameMonth) {
        monthTotalExpenses += val;
        dailyExpenseMap.set(d.day, (dailyExpenseMap.get(d.day) || 0) + val);
      }
    });

    const expensesByCategory = Array.from(categoryMap.entries())
      .map(([name, value]) => ({
        name,
        value: Number(value.toFixed(2)),
      }))
      .sort((a, b) => b.value - a.value);

    const dailyIncomeMap = new Map<number, number>();
    let monthTotalIncome = 0;
    let monthScheduledIncome = 0;

    incomes.forEach((inc) => {
      const start = parseDateOnly(inc.incomeDate);
      const val = Number(inc.value);

      if (!inc.isRecurring) {
        if (start.year === year && start.month === monthNum) {
          if (compareDateParts(start, today) <= 0) {
            monthTotalIncome += val;
            dailyIncomeMap.set(
              start.day,
              (dailyIncomeMap.get(start.day) || 0) + val,
            );
          } else {
            monthScheduledIncome += val;
          }
        }
      } else {
        const startMonthIdx = start.year * 12 + (start.month - 1);
        const targetMonthIdx = year * 12 + (monthNum - 1);
        if (targetMonthIdx < startMonthIdx) return;

        const payDay = Math.min(start.day, daysInMonth);
        const occDate = { year, month: monthNum, day: payDay };
        if (compareDateParts(occDate, today) <= 0) {
          monthTotalIncome += val;
          dailyIncomeMap.set(payDay, (dailyIncomeMap.get(payDay) || 0) + val);
        } else {
          monthScheduledIncome += val;
        }
      }
    });

    const checkpointDays = new Set<number>([1, 5, 10, 15, 20, 25, daysInMonth]);
    dailyIncomeMap.forEach((_v, day) => checkpointDays.add(day));
    dailyExpenseMap.forEach((_v, day) => checkpointDays.add(day));

    const sortedDays = Array.from(checkpointDays)
      .filter((d) => d >= 1 && d <= daysInMonth)
      .sort((a, b) => a - b);

    const monthShort = new Date(year, monthNum - 1, 1)
      .toLocaleString('pt-BR', { month: 'short' })
      .replace('.', '');

    let accIncome = 0;
    let accExpenses = 0;
    let cursorDay = 1;
    const monthlyHistory: {
      month: string;
      day: number;
      income: number;
      expenses: number;
    }[] = [];

    for (const targetDay of sortedDays) {
      while (cursorDay <= targetDay) {
        accIncome += dailyIncomeMap.get(cursorDay) || 0;
        accExpenses += dailyExpenseMap.get(cursorDay) || 0;
        cursorDay += 1;
      }

      monthlyHistory.push({
        month: `${String(targetDay).padStart(2, '0')}/${monthShort}`,
        day: targetDay,
        income: Number(accIncome.toFixed(2)),
        expenses: Number(accExpenses.toFixed(2)),
      });
    }

    return {
      month: monthKey,
      scope: authScope.mode,
      expensesByCategory,
      monthlyHistory,
      monthSummary: {
        month: monthKey,
        totalIncome: Number(monthTotalIncome.toFixed(2)),
        scheduledIncome: Number(monthScheduledIncome.toFixed(2)),
        totalExpenses: Number(monthTotalExpenses.toFixed(2)),
        netFlow: Number((monthTotalIncome - monthTotalExpenses).toFixed(2)),
      },
      availableMonths,
    };
  }
}
