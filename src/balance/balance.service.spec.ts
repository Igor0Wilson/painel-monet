import { BadRequestException } from '@nestjs/common';
import { InMemoryFirebaseService } from '../../test/__mocks__/firebase.service.mock';
import { COLLECTIONS } from '../firebase/firebase.types';
import { BalanceService } from './balance.service';

describe('BalanceService (Firestore)', () => {
  let firebase: InMemoryFirebaseService;
  let familyService: any;
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
            { id: 'u-1', name: 'Igor', maskedCpf: '***.456.789-**', phone: null },
          ],
        ]),
        familyGroupId: null,
      }),
      notifyFamilyDataChanged: jest.fn().mockResolvedValue(undefined),
    };

    service = new BalanceService(firebase as any, familyService);
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
});
