import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import { normalizeOfficialCategory } from '../account-types/account-types.service';
import { AuditService } from '../common/audit.service';
import { buildProtectedMediaPath } from '../common/cloudinary.service';
import { maskPhone } from '../common/cpf.utils';
import {
  FamilyService,
  FULL_MEMBER_PERMISSIONS,
} from '../family/family.service';
import { FirebaseService } from '../firebase/firebase.service';
import {
  AccountTypeDoc,
  COLLECTIONS,
  ExpenseDoc,
  ExpensePaymentPart,
  FamilyMemberPermissions,
  FoodBenefitConfig,
  IncomeDoc,
  InvestmentDoc,
  UserDoc,
  YieldHistoryEntry,
} from '../firebase/firebase.types';
import {
  compareDateParts,
  DateParts,
  evaluateIncomeCredit,
  formatDateOnly,
  getDaysInMonth,
  getMonthKeyFromParts,
  getTodayParts,
  parseDateOnly,
  parseMonthKey,
  shiftMonthKey,
} from '../income/income.date-utils';
import { BatchUpdateInvestmentsDto } from './dto/batch-update-investments.dto';
import { CloseFoodMonthDto } from './dto/close-food-month.dto';
import { CreateInvestmentItemDto } from './dto/create-investment-item.dto';
import { UpdateEmergencyYieldDto } from './dto/update-emergency-yield.dto';
import { UpdateFoodAllowanceDto } from './dto/update-food-allowance.dto';
import { UpdateInvestmentItemDto } from './dto/update-investment-item.dto';

export interface InvestmentItemView extends InvestmentDoc {
  ownerId: string;
  ownerName: string;
  isOwn: boolean;
}

@Injectable()
export class BalanceService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly familyService: FamilyService,
    @Optional() private readonly auditService?: AuditService,
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
    let vaUsed = 0;
    let vrUsed = 0;

    for (const curr of userExpenses) {
      if (Array.isArray(curr.payments) && curr.payments.length > 0) {
        for (const part of curr.payments) {
          if (part.paymentMethod === 'credito') continue;
          const partVal = Number(part.amount || 0);
          if (part.paymentMethod === 'va') {
            vaUsed += partVal;
          } else if (part.paymentMethod === 'vr') {
            vrUsed += partVal;
          } else {
            cashExpenses += partVal;
          }
        }
        continue;
      }

      if (curr.isPaid) {
        if (curr.paymentMethod === 'credito') continue;
        const val =
          curr.isEarlyPayment && Number(curr.paidAmount || 0) > 0
            ? Number(Math.min(Number(curr.value), Number(curr.paidAmount)))
            : Number(curr.value);
        if (curr.paymentMethod === 'va') {
          vaUsed += val;
        } else if (curr.paymentMethod === 'vr') {
          vrUsed += val;
        } else {
          cashExpenses += val;
        }
      } else if (
        curr.paidAmount !== undefined &&
        curr.paidAmount !== null &&
        Number(curr.paidAmount) > 0 &&
        curr.paymentMethod !== 'credito'
      ) {
        const partialVal = Math.min(Number(curr.value), Number(curr.paidAmount));
        if (curr.paymentMethod === 'va') {
          vaUsed += partialVal;
        } else if (curr.paymentMethod === 'vr') {
          vrUsed += partialVal;
        } else {
          cashExpenses += partialVal;
        }
      }
    }

    const foodAllowanceUsed = vaUsed + vrUsed;

    return {
      totalIncome,
      scheduledIncome,
      cashExpenses,
      foodAllowanceUsed,
      vaUsed: Number(vaUsed.toFixed(2)),
      vrUsed: Number(vrUsed.toFixed(2)),
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

  private evaluateSingleFoodBenefit(
    config: FoodBenefitConfig | null | undefined,
    today: DateParts,
  ) {
    if (!config || !config.enabled) {
      return {
        creditedAmount: 0,
        scheduledAmount: 0,
        configuredAmount: 0,
        nextCreditDate: null as string | null,
      };
    }
    const evalRes = evaluateIncomeCredit(
      {
        value: Number(config.amount || 0),
        incomeDate: config.creditDate || formatDateOnly(today),
        isRecurring: Boolean(config.isRecurring),
        recurrenceEndMonth: config.recurrenceEndMonth ?? null,
        monthlyOverrides: config.monthlyOverrides ?? null,
      },
      today,
    );
    return {
      creditedAmount: evalRes.creditedAmount,
      scheduledAmount: evalRes.scheduledAmount,
      configuredAmount: Number(config.amount || 0),
      nextCreditDate: evalRes.nextCreditDate || config.creditDate || null,
    };
  }

  private computeUserMetrics(
    user: UserDoc,
    userIncomes: IncomeDoc[],
    userExpenses: ExpenseDoc[],
    today = getTodayParts(),
  ) {
    const {
      totalIncome,
      scheduledIncome,
      cashExpenses,
      foodAllowanceUsed,
      vaUsed,
      vrUsed,
    } = this.computeCashAndIncome(userIncomes, userExpenses, today);

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
    let vaTotal = 0;
    let vaScheduled = 0;
    let vrTotal = 0;
    let vrScheduled = 0;

    if (user.vaConfig || user.vrConfig) {
      const vaEval = this.evaluateSingleFoodBenefit(user.vaConfig, today);
      const vrEval = this.evaluateSingleFoodBenefit(user.vrConfig, today);
      vaTotal = vaEval.creditedAmount;
      vaScheduled = vaEval.scheduledAmount;
      vrTotal = vrEval.creditedAmount;
      vrScheduled = vrEval.scheduledAmount;
      foodAllowanceTotal = vaTotal + vrTotal;
      foodAllowanceScheduled = vaScheduled + vrScheduled;
      const candidateDates = [vaEval.nextCreditDate, vrEval.nextCreditDate].filter(
        (d): d is string => Boolean(d),
      );
      foodAllowanceNextDate =
        candidateDates.sort((a, b) => a.localeCompare(b))[0] || foodAllowanceDate;
    } else if (foodAllowanceConfigured > 0) {
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

    const vaRemaining = Math.max(0, Number((vaTotal - vaUsed).toFixed(2)));
    const vrRemaining = Math.max(0, Number((vrTotal - vrUsed).toFixed(2)));
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
      emergencyFundTotalYield: Number(user.emergencyFundTotalYield || 0),
      emergencyFundYieldHistory: Array.isArray(user.emergencyFundYieldHistory)
        ? user.emergencyFundYieldHistory
        : [],
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
      vaTotal: Number(vaTotal.toFixed(2)),
      vaScheduled: Number(vaScheduled.toFixed(2)),
      vaUsed,
      vaRemaining,
      vrTotal: Number(vrTotal.toFixed(2)),
      vrScheduled: Number(vrScheduled.toFixed(2)),
      vrUsed,
      vrRemaining,
      vaConfig: user.vaConfig || null,
      vrConfig: user.vrConfig || null,
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

        const rawMetrics = this.computeUserMetrics(
          effectiveUser,
          uIncomes,
          uExpenses,
          today,
        );
        const permissions: FamilyMemberPermissions =
          u.id === userId || authScope.mode !== 'family'
            ? { ...FULL_MEMBER_PERMISSIONS }
            : (authScope.memberPermissions?.get(u.id) ?? {
                ...FULL_MEMBER_PERMISSIONS,
              });

        const metrics = {
          ...rawMetrics,
          balance: permissions.viewBalance ? rawMetrics.balance : 0,
          totalIncome: permissions.viewIncome ? rawMetrics.totalIncome : 0,
          scheduledIncome: permissions.viewIncome
            ? rawMetrics.scheduledIncome
            : 0,
          totalExpenses: permissions.viewExpenses
            ? rawMetrics.totalExpenses
            : 0,
          emergencyFund: permissions.viewEmergencyFund
            ? rawMetrics.emergencyFund
            : 0,
          allocatedEmergencyFund: permissions.viewEmergencyFund
            ? rawMetrics.allocatedEmergencyFund
            : 0,
          externalEmergencyFund: permissions.viewEmergencyFund
            ? rawMetrics.externalEmergencyFund
            : 0,
          investments: permissions.viewInvestments ? rawMetrics.investments : 0,
          allocatedInvestments: permissions.viewInvestments
            ? rawMetrics.allocatedInvestments
            : 0,
          externalInvestments: permissions.viewInvestments
            ? rawMetrics.externalInvestments
            : 0,
          foodAllowance: permissions.viewFoodAllowance
            ? rawMetrics.foodAllowance
            : 0,
          foodAllowanceTotal: permissions.viewFoodAllowance
            ? rawMetrics.foodAllowanceTotal
            : 0,
          foodAllowanceConfigured: permissions.viewFoodAllowance
            ? rawMetrics.foodAllowanceConfigured
            : 0,
          foodAllowanceScheduled: permissions.viewFoodAllowance
            ? rawMetrics.foodAllowanceScheduled
            : 0,
          foodAllowanceUsed: permissions.viewFoodAllowance
            ? rawMetrics.foodAllowanceUsed
            : 0,
          foodAllowanceDate: permissions.viewFoodAllowance
            ? rawMetrics.foodAllowanceDate
            : null,
          foodAllowanceNextDate: permissions.viewFoodAllowance
            ? rawMetrics.foodAllowanceNextDate
            : null,
          vaTotal: permissions.viewFoodAllowance ? rawMetrics.vaTotal : 0,
          vaScheduled: permissions.viewFoodAllowance ? rawMetrics.vaScheduled : 0,
          vaUsed: permissions.viewFoodAllowance ? rawMetrics.vaUsed : 0,
          vaRemaining: permissions.viewFoodAllowance ? rawMetrics.vaRemaining : 0,
          vrTotal: permissions.viewFoodAllowance ? rawMetrics.vrTotal : 0,
          vrScheduled: permissions.viewFoodAllowance ? rawMetrics.vrScheduled : 0,
          vrUsed: permissions.viewFoodAllowance ? rawMetrics.vrUsed : 0,
          vrRemaining: permissions.viewFoodAllowance ? rawMetrics.vrRemaining : 0,
          vaConfig: permissions.viewFoodAllowance ? rawMetrics.vaConfig : null,
          vrConfig: permissions.viewFoodAllowance ? rawMetrics.vrConfig : null,
          emergencyFundTotalYield: permissions.viewEmergencyFund
            ? rawMetrics.emergencyFundTotalYield
            : 0,
          emergencyFundYieldHistory: permissions.viewEmergencyFund
            ? rawMetrics.emergencyFundYieldHistory
            : [],
        };

        const info = authScope.userMap.get(u.id);
        const allowFullContact =
          u.id === userId || Object.values(permissions).every(Boolean);
        return {
          userId: u.id,
          name: u.name,
          maskedCpf: info?.maskedCpf || '***.***.***-**',
          maskedPhone: maskPhone(u.phone),
          phone: allowFullContact ? u.phone || null : null,
          avatarUrl: buildProtectedMediaPath(
            'avatar',
            u.id,
            u.avatarUrl,
            u.avatarPublicId,
          ),
          isSelf: u.id === userId,
          permissions,
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
      ownVaTotal: selfMetrics?.vaTotal ?? 0,
      ownVaScheduled: selfMetrics?.vaScheduled ?? 0,
      ownVaUsed: selfMetrics?.vaUsed ?? 0,
      ownVaRemaining: selfMetrics?.vaRemaining ?? 0,
      ownVrTotal: selfMetrics?.vrTotal ?? 0,
      ownVrScheduled: selfMetrics?.vrScheduled ?? 0,
      ownVrUsed: selfMetrics?.vrUsed ?? 0,
      ownVrRemaining: selfMetrics?.vrRemaining ?? 0,
      ownVaConfig: selfMetrics?.vaConfig ?? null,
      ownVrConfig: selfMetrics?.vrConfig ?? null,
      ownEmergencyFundTotalYield: selfMetrics?.emergencyFundTotalYield ?? 0,
      ownEmergencyFundYieldHistory: selfMetrics?.emergencyFundYieldHistory ?? [],
      memberBreakdown,
    };
  }

  async reconcileSavingsOnIncomeChange(userId: string): Promise<void> {
    const [user, userIncomes, userExpenses, investmentItems] = await Promise.all([
      this.firebase.findById<UserDoc>(COLLECTIONS.USERS, userId),
      this.firebase.findByField<IncomeDoc>(COLLECTIONS.INCOME, 'userId', userId),
      this.firebase.findByField<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        userId,
      ),
      this.firebase.findByField<InvestmentDoc>(
        COLLECTIONS.INVESTMENTS,
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

    const now = new Date().toISOString();
    let remainingToReclassify = Number(
      (Number(user.investments || 0) - shift.investments).toFixed(2),
    );

    if (remainingToReclassify > 0.001 && investmentItems.length > 0) {
      const balanceItems = investmentItems
        .filter((it) => it.source === 'balance')
        .sort((a, b) => a.investedDate.localeCompare(b.investedDate));

      for (const item of balanceItems) {
        if (remainingToReclassify <= 0.001) break;
        const itemAmount = Number(item.amount);
        if (itemAmount <= remainingToReclassify + 0.001) {
          await this.firebase.updateDoc(COLLECTIONS.INVESTMENTS, item.id, {
            source: 'external',
            allocatedPrincipal: 0,
            updatedAt: now,
          });
          remainingToReclassify = Number(
            (remainingToReclassify - itemAmount).toFixed(2),
          );
        } else {
          const keepOnBalance = Number(
            (itemAmount - remainingToReclassify).toFixed(2),
          );
          await this.firebase.updateDoc(COLLECTIONS.INVESTMENTS, item.id, {
            amount: keepOnBalance,
            allocatedPrincipal: keepOnBalance,
            updatedAt: now,
          });
          const movedSplit: InvestmentDoc = {
            id: uuidv4(),
            userId,
            name: `${item.name} (reclassificado)`,
            category: item.category,
            amount: remainingToReclassify,
            principalAmount: remainingToReclassify,
            allocatedPrincipal: 0,
            yieldAmount: 0,
            investedDate: item.investedDate,
            source: 'external',
            notes: item.notes ?? null,
            createdAt: now,
            updatedAt: now,
          };
          await this.firebase.setDoc(COLLECTIONS.INVESTMENTS, movedSplit);
          remainingToReclassify = 0;
        }
      }
    }

    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      ...shift,
      updatedAt: now,
    });
  }

  private async materializeLegacyInvestmentsIfEmpty(
    user: UserDoc,
  ): Promise<InvestmentDoc[]> {
    const existing = await this.firebase.findByField<InvestmentDoc>(
      COLLECTIONS.INVESTMENTS,
      'userId',
      user.id,
    );
    if (existing.length > 0) {
      return existing;
    }

    const legacyExt = Number(user.externalInvestments || 0);
    const legacyAlloc = Number(user.investments || 0);
    if (legacyExt <= 0 && legacyAlloc <= 0) {
      return [];
    }

    const now = new Date().toISOString();
    const defaultDate =
      user.createdAt && /^\d{4}-\d{2}-\d{2}/.test(user.createdAt)
        ? user.createdAt.slice(0, 10)
        : formatDateOnly(getTodayParts());

    const seeded: InvestmentDoc[] = [];

    if (legacyExt > 0) {
      const extItem: InvestmentDoc = {
        id: uuidv4(),
        userId: user.id,
        name: 'Carteira anterior consolidada',
        category: 'Renda Fixa',
        amount: Number(legacyExt.toFixed(2)),
        investedDate: defaultDate,
        source: 'external',
        notes: 'Saldo migrado automaticamente para controle detalhado',
        createdAt: now,
        updatedAt: now,
      };
      await this.firebase.setDoc(COLLECTIONS.INVESTMENTS, extItem);
      seeded.push(extItem);
    }

    if (legacyAlloc > 0) {
      const allocItem: InvestmentDoc = {
        id: uuidv4(),
        userId: user.id,
        name: 'Aporte alocado do saldo do mês',
        category: 'Renda Fixa',
        amount: Number(legacyAlloc.toFixed(2)),
        investedDate: formatDateOnly(getTodayParts()),
        source: 'balance',
        notes: 'Aporte vinculado ao saldo livre mensal',
        createdAt: now,
        updatedAt: now,
      };
      await this.firebase.setDoc(COLLECTIONS.INVESTMENTS, allocItem);
      seeded.push(allocItem);
    }

    return seeded;
  }

  private async syncUserInvestmentTotalsFromItems(
    userId: string,
  ): Promise<void> {
    const items = await this.firebase.findByField<InvestmentDoc>(
      COLLECTIONS.INVESTMENTS,
      'userId',
      userId,
    );
    let balanceSum = 0;
    let externalSum = 0;

    for (const item of items) {
      const amt = Number(item.amount || 0);
      if (item.source === 'balance') {
        const allocatedCap =
          item.allocatedPrincipal !== undefined && item.allocatedPrincipal !== null
            ? Math.min(amt, Number(item.allocatedPrincipal))
            : amt;
        balanceSum += allocatedCap;
        externalSum += Math.max(0, Number((amt - allocatedCap).toFixed(2)));
      } else {
        externalSum += amt;
      }
    }

    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      investments: Number(balanceSum.toFixed(2)),
      externalInvestments: Number(externalSum.toFixed(2)),
      updatedAt: new Date().toISOString(),
    });
  }

  async getInvestmentItems(
    userId: string,
    scope?: string,
  ): Promise<InvestmentItemView[]> {
    const authScope = await this.familyService.resolveAuthorizedScope(
      userId,
      scope,
    );
    const selfUser = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (selfUser) {
      await this.materializeLegacyInvestmentsIfEmpty(selfUser);
    }

    const visibleUserIds =
      authScope.mode === 'family'
        ? authScope.userIds.filter(
            (uid) =>
              uid === userId ||
              (authScope.memberPermissions?.get(uid)?.viewInvestments ?? true),
          )
        : authScope.userIds;

    const items = await this.firebase.findByFieldIn<InvestmentDoc>(
      COLLECTIONS.INVESTMENTS,
      'userId',
      visibleUserIds,
    );

    return items
      .sort((a, b) => b.investedDate.localeCompare(a.investedDate))
      .map((item) => ({
        ...item,
        amount: Number(item.amount),
        ownerId: item.userId,
        ownerName: authScope.userMap.get(item.userId)?.name || 'Usuário',
        isOwn: item.userId === userId,
      }));
  }

  async createInvestmentItem(userId: string, dto: CreateInvestmentItemDto) {
    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    await this.materializeLegacyInvestmentsIfEmpty(user);

    const amount = Number(Number(dto.amount).toFixed(2));
    if (dto.source === 'balance') {
      const current = await this.getBalance(userId, 'individual');
      if (amount > current.ownBalance + 0.001) {
        throw new BadRequestException(
          'Saldo disponível insuficiente para este aporte do mês. Use "Carteira já existente" para registrar investimentos anteriores.',
        );
      }
    }

    const now = new Date().toISOString();
    const doc: InvestmentDoc = {
      id: uuidv4(),
      userId,
      name: dto.name.trim(),
      category: dto.category.trim(),
      amount,
      principalAmount: amount,
      allocatedPrincipal: dto.source === 'balance' ? amount : 0,
      yieldAmount: 0,
      lastYieldUpdateAt: null,
      yieldHistory: [],
      investedDate: dto.investedDate,
      source: dto.source,
      notes: dto.notes?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };

    await this.firebase.setDoc(COLLECTIONS.INVESTMENTS, doc);
    await this.syncUserInvestmentTotalsFromItems(userId);
    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'investments.create',
      resource: 'investments',
      resourceId: doc.id,
      outcome: 'ALLOW',
    });

    return doc;
  }

  async updateInvestmentItem(
    userId: string,
    itemId: string,
    dto: UpdateInvestmentItemDto,
  ) {
    const existing = await this.firebase.findById<InvestmentDoc>(
      COLLECTIONS.INVESTMENTS,
      itemId,
    );
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Investimento não encontrado.');
    }

    const nextSource = dto.source ?? existing.source;
    const nextAmount =
      dto.amount !== undefined
        ? Number(Number(dto.amount).toFixed(2))
        : Number(existing.amount);

    const oldBalanceImpact =
      existing.source === 'balance' ? Number(existing.amount) : 0;
    const newBalanceImpact = nextSource === 'balance' ? nextAmount : 0;
    const additionalRequired = Number(
      (newBalanceImpact - oldBalanceImpact).toFixed(2),
    );

    if (additionalRequired > 0.001) {
      const current = await this.getBalance(userId, 'individual');
      if (additionalRequired > current.ownBalance + 0.001) {
        throw new BadRequestException(
          'O aumento do aporte excede o seu patrimônio disponível do mês.',
        );
      }
    }

    const updateData: Partial<InvestmentDoc> = {
      updatedAt: new Date().toISOString(),
    };
    if (dto.name !== undefined) updateData.name = dto.name.trim();
    if (dto.category !== undefined) updateData.category = dto.category.trim();
    if (dto.amount !== undefined) {
      updateData.amount = nextAmount;
      updateData.principalAmount = nextAmount;
      updateData.yieldAmount = 0;
    }
    if (dto.investedDate !== undefined) {
      updateData.investedDate = dto.investedDate;
    }
    if (dto.source !== undefined) {
      updateData.source = dto.source;
      updateData.allocatedPrincipal = dto.source === 'balance' ? nextAmount : 0;
    } else if (dto.amount !== undefined && existing.source === 'balance') {
      updateData.allocatedPrincipal = nextAmount;
    }
    if (dto.notes !== undefined) updateData.notes = dto.notes.trim() || null;

    await this.firebase.updateDoc(COLLECTIONS.INVESTMENTS, itemId, updateData);
    await this.syncUserInvestmentTotalsFromItems(userId);
    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    return { ...existing, ...updateData };
  }

  async batchUpdateInvestmentBalances(
    userId: string,
    dto: BatchUpdateInvestmentsDto,
  ) {
    const items = await this.firebase.findByField<InvestmentDoc>(
      COLLECTIONS.INVESTMENTS,
      'userId',
      userId,
    );
    const itemsById = new Map(items.map((it) => [it.id, it]));
    const today = getTodayParts();
    const month = dto.month || getMonthKeyFromParts(today);
    const date = dto.date || formatDateOnly(today);
    const now = new Date().toISOString();
    let updatedCount = 0;
    let totalYieldDelta = 0;

    for (const upd of dto.updates) {
      const existing = itemsById.get(upd.id);
      if (!existing || existing.userId !== userId) {
        throw new NotFoundException(`Investimento ${upd.id} não encontrado.`);
      }
      const newAmount = Number(Number(upd.newAmount).toFixed(2));
      const previousAmount = Number(Number(existing.amount).toFixed(2));
      const delta = Number((newAmount - previousAmount).toFixed(2));
      if (Math.abs(delta) < 0.005) continue;

      const principal =
        existing.principalAmount !== undefined && existing.principalAmount !== null
          ? Number(existing.principalAmount)
          : previousAmount;
      const allocatedCap =
        existing.source === 'balance'
          ? (existing.allocatedPrincipal !== undefined &&
            existing.allocatedPrincipal !== null
              ? Number(existing.allocatedPrincipal)
              : previousAmount)
          : 0;
      const yieldAmount = Number((newAmount - principal).toFixed(2));
      const historyEntry: YieldHistoryEntry = {
        id: uuidv4(),
        month,
        previousAmount,
        newAmount,
        delta,
        date,
        note: upd.note?.trim() || 'Atualização de saldo / rendimento',
      };
      const nextHistory = [
        ...(Array.isArray(existing.yieldHistory) ? existing.yieldHistory : []),
        historyEntry,
      ].slice(-36);

      await this.firebase.updateDoc(COLLECTIONS.INVESTMENTS, existing.id, {
        amount: newAmount,
        principalAmount: principal,
        allocatedPrincipal: allocatedCap,
        yieldAmount,
        lastYieldUpdateAt: date,
        yieldHistory: nextHistory,
        updatedAt: now,
      });
      updatedCount += 1;
      totalYieldDelta = Number((totalYieldDelta + delta).toFixed(2));
    }

    if (updatedCount > 0) {
      await this.syncUserInvestmentTotalsFromItems(userId);
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
      void this.auditService?.log({
        actorUserId: userId,
        action: 'investments.batch_yield_update',
        resource: 'investments',
        outcome: 'ALLOW',
        details: `count=${updatedCount}`,
      });
    }

    return {
      updatedCount,
      totalYieldDelta,
      balance: await this.getBalance(userId, 'individual'),
    };
  }

  async removeInvestmentItem(userId: string, itemId: string): Promise<void> {
    const existing = await this.firebase.findById<InvestmentDoc>(
      COLLECTIONS.INVESTMENTS,
      itemId,
    );
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Investimento não encontrado.');
    }

    await this.firebase.deleteDoc(COLLECTIONS.INVESTMENTS, itemId);
    await this.syncUserInvestmentTotalsFromItems(userId);
    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    void this.auditService?.log({
      actorUserId: userId,
      action: 'investments.delete',
      resource: 'investments',
      resourceId: itemId,
      outcome: 'ALLOW',
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
        if (allocatedField === 'investments') {
          const items = await this.firebase.findByField<InvestmentDoc>(
            COLLECTIONS.INVESTMENTS,
            'userId',
            userId,
          );
          for (const item of items) {
            if (item.source === 'balance') {
              await this.firebase.updateDoc(COLLECTIONS.INVESTMENTS, item.id, {
                source: 'external',
                allocatedPrincipal: 0,
                updatedAt: now,
              });
            }
          }
        }
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

  async applyEmergencyFundYield(
    userId: string,
    dto: UpdateEmergencyYieldDto,
  ) {
    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }
    if (dto.newTotal === undefined && dto.yieldAmount === undefined) {
      throw new BadRequestException(
        'Informe o novo saldo total da reserva ou o valor do rendimento.',
      );
    }

    const allocated = Number(user.emergencyFund || 0);
    const external = Number(user.externalEmergencyFund || 0);
    const currentTotal = Number((allocated + external).toFixed(2));
    const targetTotal =
      dto.newTotal !== undefined
        ? Number(Number(dto.newTotal).toFixed(2))
        : Number((currentTotal + Number(dto.yieldAmount || 0)).toFixed(2));
    const delta = Number((targetTotal - currentTotal).toFixed(2));

    if (targetTotal < 0) {
      throw new BadRequestException('O saldo total da reserva não pode ser negativo.');
    }

    const nextExternal = Number((external + delta).toFixed(2));
    if (nextExternal < -0.001) {
      throw new BadRequestException(
        'Para reduzir abaixo do valor alocado do mês, resgate ou reclassifique a parte alocada do mês primeiro.',
      );
    }

    const today = getTodayParts();
    const month = dto.month || getMonthKeyFromParts(today);
    const date = dto.date || formatDateOnly(today);
    const now = new Date().toISOString();

    const entry: YieldHistoryEntry = {
      id: uuidv4(),
      month,
      previousAmount: currentTotal,
      newAmount: targetTotal,
      delta,
      date,
      note: dto.note?.trim() || 'Rendimento / ajuste de saldo da reserva',
    };
    const nextHistory = [
      ...(Array.isArray(user.emergencyFundYieldHistory)
        ? user.emergencyFundYieldHistory
        : []),
      entry,
    ].slice(-36);
    const nextTotalYield = Number(
      (Number(user.emergencyFundTotalYield || 0) + delta).toFixed(2),
    );

    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      externalEmergencyFund: Math.max(0, nextExternal),
      emergencyFundTotalYield: nextTotalYield,
      emergencyFundYieldHistory: nextHistory,
      updatedAt: now,
    });
    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'emergency_fund.yield_update',
      resource: 'users',
      resourceId: userId,
      outcome: 'ALLOW',
    });

    return this.getBalance(userId, 'individual');
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

  private mergeFoodBenefitWithScope(
    existing: FoodBenefitConfig | null | undefined,
    incoming: {
      enabled: boolean;
      amount: number;
      creditDate: string;
      isRecurring: boolean;
      mode: 'fixed' | 'variable';
    },
    editScope: 'only_month' | 'from_month' | 'all',
    targetMonth: string,
  ): FoodBenefitConfig {
    if (!existing || !existing.enabled || editScope === 'all') {
      return {
        enabled: incoming.enabled,
        amount: Number(Number(incoming.amount).toFixed(2)),
        creditDate: incoming.creditDate,
        isRecurring: Boolean(incoming.isRecurring),
        mode: incoming.mode,
        recurrenceEndMonth: existing?.recurrenceEndMonth ?? null,
        monthlyOverrides: existing?.monthlyOverrides ?? {},
      };
    }

    const startMonth = getMonthKeyFromParts(
      parseDateOnly(existing.creditDate || incoming.creditDate),
    );
    const overrides = { ...(existing.monthlyOverrides || {}) };

    if (editScope === 'only_month') {
      overrides[targetMonth] = {
        amount: Number(Number(incoming.amount).toFixed(2)),
        creditDate: incoming.creditDate,
        skipped: !incoming.enabled,
      };
      return {
        ...existing,
        mode: incoming.mode,
        monthlyOverrides: overrides,
      };
    }

    // from_month: preserva os meses passados [startMonth .. targetMonth-1] com o valor anterior
    if (existing.isRecurring && targetMonth > startMonth) {
      let cursor = startMonth;
      let guard = 0;
      while (cursor < targetMonth && guard < 120) {
        if (!overrides[cursor]) {
          overrides[cursor] = {
            amount: Number(existing.amount || 0),
          };
        }
        cursor = shiftMonthKey(cursor, 1);
        guard += 1;
      }
    }

    Object.keys(overrides).forEach((mKey) => {
      if (mKey >= targetMonth) {
        delete overrides[mKey];
      }
    });

    return {
      enabled: incoming.enabled,
      amount: Number(Number(incoming.amount).toFixed(2)),
      creditDate: incoming.creditDate,
      isRecurring: Boolean(incoming.isRecurring),
      mode: incoming.mode,
      recurrenceEndMonth: existing.recurrenceEndMonth ?? null,
      monthlyOverrides: overrides,
    };
  }

  async updateFoodAllowance(
    userId: string,
    amount: number,
    creditDate?: string,
    isRecurring?: boolean,
    extraDto?: UpdateFoodAllowanceDto,
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
      const now = new Date().toISOString();
      const editScope = extraDto?.editScope || 'all';
      const targetMonth =
        extraDto?.targetMonth || getMonthKeyFromParts(getTodayParts());

      if (extraDto?.va || extraDto?.vr || extraDto?.benefit === 'va' || extraDto?.benefit === 'vr') {
        let nextVa = user.vaConfig ?? null;
        let nextVr = user.vrConfig ?? null;

        if (extraDto.va) {
          nextVa = this.mergeFoodBenefitWithScope(
            user.vaConfig,
            {
              enabled: extraDto.va.enabled,
              amount: Number(extraDto.va.amount || 0),
              creditDate: extraDto.va.creditDate || todayIso,
              isRecurring: Boolean(extraDto.va.isRecurring),
              mode: extraDto.va.mode || 'fixed',
            },
            editScope,
            targetMonth,
          );
        } else if (extraDto.benefit === 'va') {
          nextVa = this.mergeFoodBenefitWithScope(
            user.vaConfig,
            {
              enabled: amount > 0,
              amount: Number(amount),
              creditDate: creditDate || user.vaConfig?.creditDate || todayIso,
              isRecurring: isRecurring ?? user.vaConfig?.isRecurring ?? true,
              mode: extraDto.mode || user.vaConfig?.mode || 'fixed',
            },
            editScope,
            targetMonth,
          );
        }

        if (extraDto.vr) {
          nextVr = this.mergeFoodBenefitWithScope(
            user.vrConfig,
            {
              enabled: extraDto.vr.enabled,
              amount: Number(extraDto.vr.amount || 0),
              creditDate: extraDto.vr.creditDate || todayIso,
              isRecurring: Boolean(extraDto.vr.isRecurring),
              mode: extraDto.vr.mode || 'variable',
            },
            editScope,
            targetMonth,
          );
        } else if (extraDto.benefit === 'vr') {
          nextVr = this.mergeFoodBenefitWithScope(
            user.vrConfig,
            {
              enabled: amount > 0,
              amount: Number(amount),
              creditDate: creditDate || user.vrConfig?.creditDate || todayIso,
              isRecurring: isRecurring ?? user.vrConfig?.isRecurring ?? true,
              mode: extraDto.mode || user.vrConfig?.mode || 'variable',
            },
            editScope,
            targetMonth,
          );
        }

        const totalConfigured = Number(
          (
            (nextVa?.enabled ? Number(nextVa.amount || 0) : 0) +
            (nextVr?.enabled ? Number(nextVr.amount || 0) : 0)
          ).toFixed(2),
        );

        await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
          vaConfig: nextVa,
          vrConfig: nextVr,
          foodAllowance: totalConfigured,
          foodAllowanceDate:
            nextVa?.creditDate || nextVr?.creditDate || user.foodAllowanceDate || todayIso,
          foodAllowanceRecurring:
            Boolean(nextVa?.isRecurring) || Boolean(nextVr?.isRecurring),
          updatedAt: now,
        });
      } else {
        await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
          foodAllowance: Number(amount),
          foodAllowanceDate: creditDate || user.foodAllowanceDate || todayIso,
          foodAllowanceRecurring:
            isRecurring !== undefined
              ? Boolean(isRecurring)
              : (user.foodAllowanceRecurring ?? true),
          updatedAt: now,
        });
      }
      await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    }
    return this.getBalance(userId, 'individual');
  }

  async closeFoodAllowanceMonth(userId: string, dto: CloseFoodMonthDto) {
    const parsedTarget = parseMonthKey(dto.month);
    if (!parsedTarget) {
      throw new BadRequestException('Informe o mês no formato AAAA-MM.');
    }

    const [user, userIncomes, userExpenses, accountTypes] = await Promise.all([
      this.firebase.findById<UserDoc>(COLLECTIONS.USERS, userId),
      this.firebase.findByField<IncomeDoc>(COLLECTIONS.INCOME, 'userId', userId),
      this.firebase.findByField<ExpenseDoc>(COLLECTIONS.EXPENSES, 'userId', userId),
      this.firebase.findByField<AccountTypeDoc>(
        COLLECTIONS.ACCOUNT_TYPES,
        'userId',
        userId,
      ),
    ]);

    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    const today = getTodayParts();
    const closingParts = parseDateOnly(dto.closingDate);
    const evalDate =
      compareDateParts(closingParts, today) > 0 ? closingParts : today;
    const metrics = this.computeUserMetrics(
      user,
      userIncomes,
      userExpenses,
      evalDate,
    );

    const hasSeparatedConfigs = Boolean(user.vaConfig || user.vrConfig);
    const expectedRemaining =
      dto.benefit === 'va' && hasSeparatedConfigs
        ? metrics.vaRemaining
        : dto.benefit === 'vr' && hasSeparatedConfigs
          ? metrics.vrRemaining
          : metrics.foodAllowance;

    const actualRemaining = Number(Number(dto.actualRemaining).toFixed(2));
    const diff = Number((expectedRemaining - actualRemaining).toFixed(2));
    const now = new Date().toISOString();

    if (Math.abs(diff) < 0.01) {
      return {
        adjusted: false,
        diff: 0,
        balance: await this.getBalance(userId, 'individual'),
      };
    }

    if (diff > 0) {
      let foodCat = accountTypes.find(
        (t) => normalizeOfficialCategory(t.name) === 'Alimentação',
      );
      if (!foodCat) {
        foodCat = {
          id: uuidv4(),
          name: 'Alimentação',
          userId,
          createdAt: now,
          updatedAt: now,
        };
        await this.firebase.setDoc(COLLECTIONS.ACCOUNT_TYPES, foodCat);
      }

      const method: 'va' | 'vr' =
        dto.benefit === 'vr' ? 'vr' : dto.benefit === 'va' ? 'va' : 'va';
      const cleanDate = String(dto.closingDate).split('T')[0];
      const labelPrefix =
        dto.benefit === 'vr'
          ? 'Fechamento VR'
          : dto.benefit === 'va'
            ? 'Fechamento VA'
            : 'Fechamento VA/VR';

      const closingExpense: ExpenseDoc = {
        id: uuidv4(),
        userId,
        accountTypeId: foodCat.id,
        name: dto.note?.trim() || `${labelPrefix} (${dto.month})`,
        value: diff,
        dueDate: cleanDate,
        isRecurring: false,
        isInstallment: false,
        installmentCount: null,
        installmentNumber: null,
        parentExpenseId: null,
        isPaid: true,
        paidAmount: diff,
        discountAmount: 0,
        isEarlyPayment: false,
        paidAt: cleanDate,
        payments: [
          {
            id: uuidv4(),
            amount: diff,
            paidAt: cleanDate,
            paymentMethod: method,
            createdAt: now,
          },
        ],
        isCreditCard: false,
        paymentMethod: method,
        createdAt: now,
        updatedAt: now,
      };
      await this.firebase.setDoc(COLLECTIONS.EXPENSES, closingExpense);
    } else {
      const creditExtra = Math.abs(diff);
      if (hasSeparatedConfigs) {
        const targetKey =
          dto.benefit === 'vr' && user.vrConfig
            ? 'vrConfig'
            : user.vaConfig
              ? 'vaConfig'
              : 'vrConfig';
        const cfg = user[targetKey];
        if (cfg) {
          const ov = cfg.monthlyOverrides?.[dto.month];
          const baseAmt = ov?.amount !== undefined ? Number(ov.amount) : Number(cfg.amount || 0);
          const nextCfg: FoodBenefitConfig = {
            ...cfg,
            monthlyOverrides: {
              ...(cfg.monthlyOverrides || {}),
              [dto.month]: {
                ...(ov || {}),
                amount: Number((baseAmt + creditExtra).toFixed(2)),
                skipped: false,
              },
            },
          };
          await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
            [targetKey]: nextCfg,
            updatedAt: now,
          });
        }
      } else {
        const nextFood = Number((Number(user.foodAllowance || 0) + creditExtra).toFixed(2));
        await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
          foodAllowance: nextFood,
          updatedAt: now,
        });
      }
    }

    await this.familyService.notifyFamilyDataChanged(userId, 'data_updated');
    void this.auditService?.log({
      actorUserId: userId,
      action: 'food_allowance.close_month',
      resource: 'users',
      resourceId: userId,
      outcome: 'ALLOW',
      details: `month=${dto.month},diff=${diff}`,
    });

    return {
      adjusted: true,
      diff,
      balance: await this.getBalance(userId, 'individual'),
    };
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

    const expenseAllowedIds =
      authScope.mode === 'family'
        ? authScope.userIds.filter(
            (uid) =>
              uid === userId ||
              (authScope.memberPermissions?.get(uid)?.viewExpenses ?? true),
          )
        : authScope.userIds;

    const incomeAllowedIds =
      authScope.mode === 'family'
        ? authScope.userIds.filter(
            (uid) =>
              uid === userId ||
              (authScope.memberPermissions?.get(uid)?.viewIncome ?? true),
          )
        : authScope.userIds;

    const [expenses, incomes, accountTypes] = await Promise.all([
      this.firebase.findByFieldIn<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        expenseAllowedIds,
      ),
      this.firebase.findByFieldIn<IncomeDoc>(
        COLLECTIONS.INCOME,
        'userId',
        incomeAllowedIds,
      ),
      this.firebase.findByFieldIn<AccountTypeDoc>(
        COLLECTIONS.ACCOUNT_TYPES,
        'userId',
        expenseAllowedIds,
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

    const materializedByParentAndMonth = new Set(
      expenses
        .filter((e) => e.recurrenceParentId && e.occurrenceMonth)
        .map((e) => `${e.recurrenceParentId}::${e.occurrenceMonth}`),
    );

    expenses.forEach((e) => {
      if (e.paymentMethod === 'credito' && !e.isCreditCard) return;
      const d = parseDateOnly(e.dueDate);
      const expMonthIdx = d.year * 12 + (d.month - 1);

      const isSameMonth = d.year === year && d.month === monthNum;
      const parsedEnd = parseMonthKey(e.recurrenceEndMonth);
      const endMonthIdx = parsedEnd ? parsedEnd.monthIndex : Number.POSITIVE_INFINITY;
      const ov = e.isRecurring ? e.monthlyOverrides?.[monthKey] : undefined;
      const isMaterializedHere =
        Boolean(e.isRecurring) &&
        materializedByParentAndMonth.has(`${e.id}::${monthKey}`);

      const isRecurringInMonth =
        Boolean(e.isRecurring) &&
        targetMonthIdx >= expMonthIdx &&
        targetMonthIdx <= endMonthIdx &&
        !ov?.skipped &&
        !isMaterializedHere;

      const effectiveVal =
        ov?.value !== undefined
          ? Number(ov.value)
          : e.isPaid && e.isEarlyPayment && Number(e.paidAmount || 0) > 0
            ? Number(Math.min(Number(e.value), Number(e.paidAmount)))
            : Number(e.value);

      if ((!e.isRecurring && isSameMonth) || isRecurringInMonth) {
        const resolvedCatId = ov?.accountTypeId ?? e.accountTypeId;
        const rawCatName = typesById.get(resolvedCatId)?.name;
        const catName = normalizeOfficialCategory(rawCatName);
        categoryMap.set(catName, (categoryMap.get(catName) || 0) + effectiveVal);
      }

      if (Array.isArray(e.payments) && e.payments.length > 0) {
        for (const part of e.payments) {
          if (part.paymentMethod === 'credito') continue;
          const pDate = parseDateOnly(part.paidAt || e.dueDate);
          if (pDate.year === year && pDate.month === monthNum) {
            const pVal = Number(part.amount || 0);
            monthTotalExpenses += pVal;
            dailyExpenseMap.set(
              pDate.day,
              (dailyExpenseMap.get(pDate.day) || 0) + pVal,
            );
          }
        }
      } else if (e.isPaid && isSameMonth && e.paymentMethod !== 'credito') {
        monthTotalExpenses += effectiveVal;
        dailyExpenseMap.set(d.day, (dailyExpenseMap.get(d.day) || 0) + effectiveVal);
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
      const baseVal = Number(inc.value);

      if (!inc.isRecurring) {
        if (start.year === year && start.month === monthNum) {
          if (compareDateParts(start, today) <= 0) {
            monthTotalIncome += baseVal;
            dailyIncomeMap.set(
              start.day,
              (dailyIncomeMap.get(start.day) || 0) + baseVal,
            );
          } else {
            monthScheduledIncome += baseVal;
          }
        }
      } else {
        const startMonthIdx = start.year * 12 + (start.month - 1);
        const parsedEnd = parseMonthKey(inc.recurrenceEndMonth);
        const endMonthIdx = parsedEnd ? parsedEnd.monthIndex : Number.POSITIVE_INFINITY;
        if (targetMonthIdx < startMonthIdx || targetMonthIdx > endMonthIdx) return;

        const ov = inc.monthlyOverrides?.[monthKey];
        if (ov?.skipped) return;

        const val = ov?.value !== undefined ? Number(ov.value) : baseVal;
        const payDay = Math.min(ov?.day ?? start.day, daysInMonth);
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
