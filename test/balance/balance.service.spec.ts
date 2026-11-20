import { BadRequestException } from '@nestjs/common';
import { BalanceService } from '../../src/balance/balance.service';
import { FamilyService } from '../../src/family/family.service';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

describe('BalanceService (Firestore)', () => {
  let firebase: InMemoryFirebaseService;
  let familyService: Pick<
    FamilyService,
    'resolveAuthorizedScope' | 'notifyFamilyDataChanged'
  >;
  let service: BalanceService;

  beforeEach(() => {
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

    service = new BalanceService(
      firebase as unknown as FirebaseService,
      familyService as unknown as FamilyService,
    );
  });

  it('computes balance deducting paid non-credit expenses, emergency fund, and investments', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: null,
      phone: null,
      emergencyFund: 500,
      investments: 1000,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-1',
      userId: 'u-1',
      name: 'Salário',
      value: 4000,
      incomeDate: '2020-01-05',
      isRecurring: false,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-2',
      userId: 'u-1',
      name: 'Futuro',
      value: 2000,
      incomeDate: '2099-12-30',
      isRecurring: false,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.EXPENSES, {
      id: 'e-1',
      userId: 'u-1',
      accountTypeId: 'cat-1',
      name: 'Pix',
      value: 300,
      isPaid: true,
      isCreditCard: false,
      paymentMethod: 'pix',
      dueDate: '2026-11-10',
      isRecurring: false,
      isInstallment: false,
      installmentCount: null,
      installmentNumber: null,
      parentExpenseId: null,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.EXPENSES, {
      id: 'e-2',
      userId: 'u-1',
      accountTypeId: 'cat-1',
      name: 'Crédito',
      value: 700,
      isPaid: true,
      isCreditCard: false,
      paymentMethod: 'credito',
      dueDate: '2026-11-10',
      isRecurring: false,
      isInstallment: false,
      installmentCount: null,
      installmentNumber: null,
      parentExpenseId: null,
      createdAt: '',
      updatedAt: '',
    });

    const res = await service.getBalance('u-1', 'individual');

    expect(res.totalIncome).toBe(4000);
    expect(res.scheduledIncome).toBe(2000);
    expect(res.totalExpenses).toBe(300);
    expect(res.emergencyFund).toBe(500);
    expect(res.investments).toBe(1000);
    expect(res.balance).toBe(2200);
  });

  it('rejects emergency fund or investment values exceeding available balance', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: null,
      phone: null,
      emergencyFund: 100,
      investments: 200,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-1',
      userId: 'u-1',
      name: 'Salário',
      value: 1000,
      incomeDate: '2020-01-01',
      isRecurring: false,
      createdAt: '',
      updatedAt: '',
    });

    await expect(service.updateEmergencyFund('u-1', 850)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.updateInvestments('u-1', 950)).rejects.toThrow(
      BadRequestException,
    );

    const updated = await service.updateInvestments('u-1', 500);
    expect(updated.investments).toBe(500);
    expect(familyService.notifyFamilyDataChanged).toHaveBeenCalledWith(
      'u-1',
      'data_updated',
    );
  });

  it('filters chart categories and summary strictly by requested month', async () => {
    await firebase.setDoc(COLLECTIONS.ACCOUNT_TYPES, {
      id: 'cat-ff',
      userId: 'u-1',
      name: 'Fast Food',
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.ACCOUNT_TYPES, {
      id: 'cat-mor',
      userId: 'u-1',
      name: 'Moradia',
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.EXPENSES, {
      id: 'e-oct',
      userId: 'u-1',
      accountTypeId: 'cat-ff',
      name: 'Burger',
      value: 200,
      isPaid: true,
      isCreditCard: false,
      paymentMethod: 'pix',
      dueDate: '2026-10-12',
      isRecurring: false,
      isInstallment: false,
      installmentCount: null,
      installmentNumber: null,
      parentExpenseId: null,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.EXPENSES, {
      id: 'e-nov',
      userId: 'u-1',
      accountTypeId: 'cat-mor',
      name: 'Aluguel',
      value: 500,
      isPaid: true,
      isCreditCard: false,
      paymentMethod: 'pix',
      dueDate: '2026-11-12',
      isRecurring: false,
      isInstallment: false,
      installmentCount: null,
      installmentNumber: null,
      parentExpenseId: null,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-oct',
      userId: 'u-1',
      name: 'Salário Out',
      value: 1500,
      incomeDate: '2026-10-05',
      isRecurring: false,
      createdAt: '',
      updatedAt: '',
    });

    const oct = await service.getChartData('u-1', '2026-10', 'individual');

    expect(oct.month).toBe('2026-10');
    expect(oct.expensesByCategory).toEqual([{ name: 'FastFood', value: 200 }]);
    expect(oct.monthSummary.totalIncome).toBe(1500);
    expect(oct.monthSummary.totalExpenses).toBe(200);
    expect(oct.monthSummary.netFlow).toBe(1300);
  });

  it('registers unlimited pre-existing investments without deducting from monthly balance', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: null,
      phone: null,
      emergencyFund: 0,
      investments: 200,
      externalInvestments: 0,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-1',
      userId: 'u-1',
      name: 'Salário',
      value: 1000,
      incomeDate: '2020-01-01',
      isRecurring: false,
      createdAt: '',
      updatedAt: '',
    });

    const updated = await service.updateInvestments('u-1', 25000, false);

    expect(updated.externalInvestments).toBe(25000);
    expect(updated.allocatedInvestments).toBe(200);
    expect(updated.investments).toBe(25200);
    expect(updated.balance).toBe(800);
  });

  it('self-heals legacy users with negative balance caused by invested funds after income removal', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: null,
      phone: null,
      emergencyFund: 0,
      investments: 10000,
      createdAt: '',
      updatedAt: '',
    });

    const healed = await service.getBalance('u-1', 'individual');

    expect(healed.balance).toBe(0);
    expect(healed.investments).toBe(10000);
    expect(healed.allocatedInvestments).toBe(0);
    expect(healed.externalInvestments).toBe(10000);
  });

  it('supports pre-existing emergency fund, reclassifying to external, and redeeming while negative', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: null,
      phone: null,
      emergencyFund: 3000,
      externalEmergencyFund: 0,
      investments: 0,
      externalInvestments: 0,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-1',
      userId: 'u-1',
      name: 'Salário',
      value: 2000,
      incomeDate: '2020-01-01',
      isRecurring: false,
      createdAt: '',
      updatedAt: '',
    });

    // Can still decrease allocated emergency fund even when balance is -1000
    const redeemed = await service.updateEmergencyFund('u-1', 1500, true, false);
    expect(redeemed.balance).toBe(500);
    expect(redeemed.allocatedEmergencyFund).toBe(1500);

    // Move remaining allocated reserve to pre-existing/external without losing reserve
    const moved = await service.updateEmergencyFund('u-1', 0, false, true);
    expect(moved.balance).toBe(2000);
    expect(moved.allocatedEmergencyFund).toBe(0);
    expect(moved.externalEmergencyFund).toBe(1500);
    expect(moved.emergencyFund).toBe(1500);

    // Pre-existing emergency fund has no limit cap
    const preExisting = await service.updateEmergencyFund('u-1', 15000, false, false);
    expect(preExisting.externalEmergencyFund).toBe(15000);
    expect(preExisting.balance).toBe(2000);
  });

  it('creates, updates, deletes detailed dated investment items and materializes legacy totals', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: null,
      phone: null,
      emergencyFund: 0,
      externalEmergencyFund: 0,
      investments: 0,
      externalInvestments: 5000,
      createdAt: '2026-01-10T00:00:00.000Z',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-1',
      userId: 'u-1',
      name: 'Salário',
      value: 3000,
      incomeDate: '2026-10-05',
      isRecurring: false,
      createdAt: '',
      updatedAt: '',
    });

    const initialItems = await service.getInvestmentItems('u-1', 'individual');
    expect(initialItems).toHaveLength(1);
    expect(initialItems[0].amount).toBe(5000);
    expect(initialItems[0].investedDate).toBe('2026-01-10');

    const added = await service.createInvestmentItem('u-1', {
      name: 'Tesouro Selic',
      category: 'Tesouro Direto',
      amount: 1000,
      investedDate: '2026-11-15',
      source: 'balance',
      notes: 'Aporte mensal',
    });

    const balAfterCreate = await service.getBalance('u-1', 'individual');
    expect(balAfterCreate.investments).toBe(6000);
    expect(balAfterCreate.allocatedInvestments).toBe(1000);
    expect(balAfterCreate.externalInvestments).toBe(5000);
    expect(balAfterCreate.balance).toBe(2000);

    await service.updateInvestmentItem('u-1', added.id, {
      amount: 1500,
      source: 'external',
    });
    const balAfterEdit = await service.getBalance('u-1', 'individual');
    expect(balAfterEdit.investments).toBe(6500);
    expect(balAfterEdit.allocatedInvestments).toBe(0);
    expect(balAfterEdit.balance).toBe(3000);

    await service.removeInvestmentItem('u-1', added.id);
    const balAfterDelete = await service.getBalance('u-1', 'individual');
    expect(balAfterDelete.investments).toBe(5000);
  });
});
