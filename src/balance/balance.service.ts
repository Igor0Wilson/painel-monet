import { BadRequestException, Injectable } from '@nestjs/common';
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

  private computeUserMetrics(
    user: UserDoc,
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

    const totalExpenses = userExpenses.reduce((acc, curr) => {
      if (curr.isPaid && curr.paymentMethod !== 'credito') {
        return acc + Number(curr.value);
      }
      return acc;
    }, 0);

    const emergencyFund = Number(user.emergencyFund || 0);
    const investments = Number(user.investments || 0);
    const balance = totalIncome - totalExpenses - emergencyFund - investments;

    return {
      balance: Number(balance.toFixed(2)),
      totalIncome: Number(totalIncome.toFixed(2)),
      scheduledIncome: Number(scheduledIncome.toFixed(2)),
      totalExpenses: Number(totalExpenses.toFixed(2)),
      emergencyFund: Number(emergencyFund.toFixed(2)),
      investments: Number(investments.toFixed(2)),
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

    const memberBreakdown = users.map((u) => {
      const uIncomes = incomes.filter((i) => i.userId === u.id);
      const uExpenses = expenses.filter((e) => e.userId === u.id);
      const metrics = this.computeUserMetrics(u, uIncomes, uExpenses, today);
      const info = authScope.userMap.get(u.id);
      return {
        userId: u.id,
        name: u.name,
        maskedCpf: info?.maskedCpf || '***.***.***-**',
        phone: u.phone || null,
        isSelf: u.id === userId,
        ...metrics,
      };
    });

    const totals = memberBreakdown.reduce(
      (acc, m) => ({
        balance: acc.balance + m.balance,
        totalIncome: acc.totalIncome + m.totalIncome,
        scheduledIncome: acc.scheduledIncome + m.scheduledIncome,
        totalExpenses: acc.totalExpenses + m.totalExpenses,
        emergencyFund: acc.emergencyFund + m.emergencyFund,
        investments: acc.investments + m.investments,
      }),
      {
        balance: 0,
        totalIncome: 0,
        scheduledIncome: 0,
        totalExpenses: 0,
        emergencyFund: 0,
        investments: 0,
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
      investments: Number(totals.investments.toFixed(2)),
      ownBalance: selfMetrics?.balance ?? 0,
      ownEmergencyFund: selfMetrics?.emergencyFund ?? 0,
      ownInvestments: selfMetrics?.investments ?? 0,
      memberBreakdown,
    };
  }

  async updateEmergencyFund(userId: string, amount: number) {
    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (user) {
      const current = await this.getBalance(userId, 'individual');
      const maxAllowed = Number(
        (current.ownBalance + current.ownEmergencyFund).toFixed(2),
      );
      if (amount > maxAllowed + 0.001) {
        throw new BadRequestException(
          'A reserva de emergência não pode exceder o seu patrimônio disponível.',
        );
      }
      await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
        emergencyFund: Number(amount),
        updatedAt: new Date().toISOString(),
      });
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    }
    return this.getBalance(userId, 'individual');
  }

  async updateInvestments(userId: string, amount: number) {
    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (user) {
      const current = await this.getBalance(userId, 'individual');
      const maxAllowed = Number(
        (current.ownBalance + current.ownInvestments).toFixed(2),
      );
      if (amount > maxAllowed + 0.001) {
        throw new BadRequestException(
          'O valor em investimentos não pode exceder o seu patrimônio disponível.',
        );
      }
      await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
        investments: Number(amount),
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

    expenses.forEach((e) => {
      if (!e.isPaid || e.paymentMethod === 'credito') return;
      const d = parseDateOnly(e.dueDate);
      if (d.year !== year || d.month !== monthNum) return;

      const val = Number(e.value);
      monthTotalExpenses += val;
      const catName = typesById.get(e.accountTypeId)?.name || 'Outros';
      categoryMap.set(catName, (categoryMap.get(catName) || 0) + val);
      dailyExpenseMap.set(d.day, (dailyExpenseMap.get(d.day) || 0) + val);
    });

    const expensesByCategory = Array.from(categoryMap.entries()).map(
      ([name, value]) => ({
        name,
        value: Number(value.toFixed(2)),
      }),
    );

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
