import { BalanceService } from '../../src/balance/balance.service';
import { ExpensesService, ExpenseWithStatus } from '../../src/expenses/expenses.service';
import { FamilyService } from '../../src/family/family.service';
import { FirebaseService } from '../../src/firebase/firebase.service';
import {
  COLLECTIONS,
  ExpenseDoc,
  IncomeDoc,
  InvestmentDoc,
} from '../../src/firebase/firebase.types';
import { IncomeService } from '../../src/income/income.service';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

describe('QA & Recurring Scopes / Cards / VA-VR / Portfolio Yields', () => {
  let firebase: InMemoryFirebaseService;
  let familyService: Pick<
    FamilyService,
    'resolveAuthorizedScope' | 'notifyFamilyDataChanged'
  >;
  let balanceService: BalanceService;
  let incomeService: IncomeService;
  let expensesService: ExpensesService;

  beforeEach(async () => {
    firebase = new InMemoryFirebaseService();
    familyService = {
      resolveAuthorizedScope: jest.fn().mockResolvedValue({
        mode: 'individual',
        userIds: ['u-1'],
        userMap: new Map([
          [
            'u-1',
            {
              id: 'u-1',
              name: 'Igor',
              maskedCpf: '***.456.789-**',
              phone: null,
            },
          ],
        ]),
        familyGroupId: null,
      }),
      notifyFamilyDataChanged: jest.fn().mockResolvedValue(undefined),
    };

    balanceService = new BalanceService(
      firebase as unknown as FirebaseService,
      familyService as unknown as FamilyService,
    );
    incomeService = new IncomeService(
      firebase as unknown as FirebaseService,
      familyService as unknown as FamilyService,
      balanceService,
    );
    expensesService = new ExpensesService(
      firebase as unknown as FirebaseService,
      familyService as unknown as FamilyService,
      undefined,
    );

    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      cpf: null,
      phone: null,
      emergencyFund: 1000,
      externalEmergencyFund: 2000,
      investments: 0,
      externalInvestments: 0,
      createdAt: '',
      updatedAt: '',
    });

    await firebase.setDoc(COLLECTIONS.ACCOUNT_TYPES, {
      id: 'cat-food',
      name: 'Alimentação',
      userId: 'u-1',
      createdAt: '',
      updatedAt: '',
    });
  });

  it('keeps future recurring bills marked as pendente (never em_atraso) and clamps day-31 credit dates accurately', async () => {
    const futureRec = (await expensesService.create(
      {
        name: 'Internet Fibra',
        accountTypeId: 'cat-food',
        value: 120,
        dueDate: '2099-03-10',
        isRecurring: true,
      },
      'u-1',
    )) as ExpenseWithStatus;

    expect(futureRec.status).toBe('pendente');

    const installments = (await expensesService.create(
      {
        name: 'Calça Ana',
        accountTypeId: 'cat-food',
        value: 300,
        dueDate: '2027-01-31',
        isRecurring: false,
        installmentCount: 3,
        paymentMethod: 'credito',
        firstInstallmentDate: '2027-01-31',
      },
      'u-1',
    )) as ExpenseWithStatus[];

    expect(installments.map((i) => i.dueDate)).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
    ]);

    // Propagates cardBank/cardLast4 across all siblings automatically
    await expensesService.update(
      installments[0].id,
      { cardBank: 'Nubank', cardLast4: '4821' },
      'u-1',
    );
    const allSaved = await firebase.findByField<ExpenseDoc>(
      COLLECTIONS.EXPENSES,
      'userId',
      'u-1',
    );
    const legs = allSaved.filter((e) => e.name.includes('Calça Ana'));
    expect(legs).toHaveLength(3);
    expect(legs.every((l) => l.cardBank === 'Nubank' && l.cardLast4 === '4821')).toBe(true);
  });

  it('supports scoped edits (only_month and from_month) and deletion on recurring salaries preserving history', async () => {
    const salary = await incomeService.create(
      {
        name: 'Salário Líquido',
        value: 5000,
        incomeDate: '2025-01-05',
        isRecurring: true,
      },
      'u-1',
    );

    // Bonus/ férias only in 2025-03
    await incomeService.update(
      salary.id,
      {
        value: 6800,
        editScope: 'only_month',
        targetMonth: '2025-03',
      },
      'u-1',
    );

    let savedSalary = await firebase.findById<IncomeDoc>(COLLECTIONS.INCOME, salary.id);
    expect(savedSalary?.value).toBe(5000);
    expect(savedSalary?.monthlyOverrides?.['2025-03']?.value).toBe(6800);

    // Permanent raise from 2025-06 onward keeps 2025-01..2025-05 untouched
    await incomeService.update(
      salary.id,
      {
        value: 5800,
        editScope: 'from_month',
        targetMonth: '2025-06',
      },
      'u-1',
    );

    savedSalary = await firebase.findById<IncomeDoc>(COLLECTIONS.INCOME, salary.id);
    expect(savedSalary?.recurrenceEndMonth).toBe('2025-05');
    expect(savedSalary?.monthlyOverrides?.['2025-03']?.value).toBe(6800);

    const allIncomes = await firebase.findByField<IncomeDoc>(COLLECTIONS.INCOME, 'userId', 'u-1');
    expect(allIncomes).toHaveLength(2);
    const raisedSeries = allIncomes.find((i) => i.id !== salary.id);
    expect(raisedSeries?.value).toBe(5800);
    expect(raisedSeries?.incomeDate).toBe('2025-06-05');

    // Delete single occurrence sets skipped=true without deleting series
    await incomeService.remove(raisedSeries!.id, 'u-1', 'only_month', '2025-08');
    const updatedRaised = await firebase.findById<IncomeDoc>(
      COLLECTIONS.INCOME,
      raisedSeries!.id,
    );
    expect(updatedRaised?.monthlyOverrides?.['2025-08']?.skipped).toBe(true);
  });

  it('materializes single-month recurring expense payment while leaving future occurrences unpaid', async () => {
    const rec = (await expensesService.create(
      {
        name: 'Aluguel',
        accountTypeId: 'cat-food',
        value: 2000,
        dueDate: '2026-10-10',
        isRecurring: true,
      },
      'u-1',
    )) as ExpenseWithStatus;

    await expensesService.markAsPaid(rec.id, 'u-1', {
      paymentMethod: 'pix',
      paidAt: '2026-11-10',
      occurrenceMonth: '2026-11',
    });

    const docs = await firebase.findByField<ExpenseDoc>(COLLECTIONS.EXPENSES, 'userId', 'u-1');
    const template = docs.find((d) => d.id === rec.id)!;
    const novCopy = docs.find(
      (d) => d.recurrenceParentId === rec.id && d.occurrenceMonth === '2026-11',
    )!;

    expect(template.isPaid).toBe(false);
    expect(template.monthlyOverrides?.['2026-11']?.materializedExpenseId).toBe(novCopy.id);
    expect(novCopy.isPaid).toBe(true);
    expect(novCopy.value).toBe(2000);
  });

  it('configures separate VA/VR fixed & variable benefits, logs batch VA/VR expenses, and closes month balance', async () => {
    await incomeService.create(
      {
        name: 'Saldo base',
        value: 8000,
        incomeDate: '2020-01-01',
        isRecurring: false,
      },
      'u-1',
    );

    const updatedBalance = await balanceService.updateFoodAllowance('u-1', 0, undefined, undefined, {
      editScope: 'all',
      va: {
        enabled: true,
        amount: 600,
        creditDate: '2020-01-05',
        isRecurring: false,
        mode: 'fixed',
      },
      vr: {
        enabled: true,
        amount: 800,
        creditDate: '2020-01-05',
        isRecurring: false,
        mode: 'variable',
      },
    });

    expect(updatedBalance.ownVaRemaining).toBe(600);
    expect(updatedBalance.ownVrRemaining).toBe(800);
    expect(updatedBalance.ownFoodAllowance).toBe(1400);

    await expensesService.createFoodExpensesBatch('u-1', {
      items: [
        { name: 'Almoço Segunda', amount: 45, date: '2026-11-16', paymentMethod: 'vr' },
        { name: 'Almoço Terça', amount: 55, date: '2026-11-17', paymentMethod: 'vr' },
        { name: 'Mercado', amount: 150, date: '2026-11-18', paymentMethod: 'va' },
      ],
    });

    const closeRes = await balanceService.closeFoodAllowanceMonth('u-1', {
      month: '2026-11',
      benefit: 'vr',
      actualRemaining: 500, // 800 - 100 spent = 700 theoretical, closing at 500 adjusts 200
      closingDate: '2026-11-30',
      note: 'Ajuste final VR',
    });

    expect(closeRes.adjusted).toBe(true);
    expect(closeRes.diff).toBe(200);
    expect(closeRes.balance.ownVrRemaining).toBe(500);
  });

  it('updates investment balances and emergency reserve yields without deducting free cash balance', async () => {
    await incomeService.create(
      {
        name: 'Salário',
        value: 5000,
        incomeDate: '2020-01-01',
        isRecurring: false,
      },
      'u-1',
    );

    const inv = await balanceService.createInvestmentItem('u-1', {
      name: 'Tesouro Selic',
      category: 'Renda Fixa',
      amount: 1000,
      investedDate: '2026-10-01',
      source: 'balance',
    });

    const beforeBalance = await balanceService.getBalance('u-1', 'individual');
    expect(beforeBalance.ownBalance).toBe(3000);
    expect(beforeBalance.ownInvestments).toBe(1000);

    // Investment grew to R$ 1150 via monthly yield
    const yieldRes = await balanceService.batchUpdateInvestmentBalances('u-1', {
      updates: [{ id: inv.id, newAmount: 1150 }],
      month: '2026-11',
      date: '2026-11-23',
    });

    expect(yieldRes.updatedCount).toBe(1);
    expect(yieldRes.totalYieldDelta).toBe(150);
    // Free cash balance stays 3000 (not reduced by yield!)
    expect(yieldRes.balance.ownBalance).toBe(3000);
    expect(yieldRes.balance.ownInvestments).toBe(1150);

    const invDoc = await firebase.findById<InvestmentDoc>(COLLECTIONS.INVESTMENTS, inv.id);
    expect(invDoc?.yieldAmount).toBe(150);
    expect(invDoc?.allocatedPrincipal).toBe(1000);

    // Apply Emergency Reserve yield (+ R$ 75) without deducting ownBalance
    const resBalance = await balanceService.applyEmergencyFundYield('u-1', {
      yieldAmount: 75,
      month: '2026-11',
      date: '2026-11-23',
      note: 'Rendimento mensal CDI',
    });

    expect(resBalance.ownBalance).toBe(3000);
    expect(resBalance.ownEmergencyFund).toBe(3075);
    expect(resBalance.ownEmergencyFundTotalYield).toBe(75);
    expect(resBalance.ownEmergencyFundYieldHistory).toHaveLength(1);
  });
});
