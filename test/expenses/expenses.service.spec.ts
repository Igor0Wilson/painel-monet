import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ExpensesService,
  ExpenseWithStatus,
} from '../../src/expenses/expenses.service';
import { FamilyService } from '../../src/family/family.service';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

describe('ExpensesService (Firestore)', () => {
  let firebase: InMemoryFirebaseService;
  let familyService: Pick<
    FamilyService,
    'resolveAuthorizedScope' | 'notifyFamilyDataChanged'
  >;
  let service: ExpensesService;

  beforeEach(async () => {
    firebase = new InMemoryFirebaseService();
    await firebase.setDoc(COLLECTIONS.ACCOUNT_TYPES, {
      id: 'cat-1',
      name: 'Eletrônicos',
      userId: 'u-1',
      createdAt: '',
      updatedAt: '',
    });

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

    service = new ExpensesService(
      firebase as unknown as FirebaseService,
      familyService as unknown as FamilyService,
    );
  });

  it('splits cent remainders accurately when creating credit card installments', async () => {
    const result = (await service.create(
      {
        name: 'Fone',
        accountTypeId: 'cat-1',
        value: 100,
        dueDate: '2026-12-10',
        isRecurring: false,
        installmentCount: 3,
        paymentMethod: 'credito',
        firstInstallmentDate: '2026-12-10',
      },
      'u-1',
    )) as ExpenseWithStatus[];

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.value)).toEqual([33.33, 33.33, 33.34]);
    expect(
      result.every((r) => r.isCreditCard === true && r.isPaid === false),
    ).toBe(true);
    expect(familyService.notifyFamilyDataChanged).toHaveBeenCalledWith(
      'u-1',
      'data_updated',
    );
  });

  it('creates spot purchase paid via Pix immediately', async () => {
    const result = (await service.create(
      {
        name: 'Fast Food',
        accountTypeId: 'cat-1',
        value: 45,
        dueDate: '2026-11-19',
        isRecurring: false,
        isPaid: true,
        paymentMethod: 'pix',
      },
      'u-1',
    )) as ExpenseWithStatus;

    expect(result.isPaid).toBe(true);
    expect(result.paymentMethod).toBe('pix');
    expect(result.status).toBe('pago');
  });

  it('marks expense as paid via Pix without generating credit card installments', async () => {
    const created = (await service.create(
      {
        name: 'Energia',
        accountTypeId: 'cat-1',
        value: 120,
        dueDate: '2026-11-19',
        isRecurring: false,
      },
      'u-1',
    )) as ExpenseWithStatus;

    const res = await service.markAsPaid(created.id, 'u-1', {
      paymentMethod: 'pix',
    });

    expect(res.isPaid).toBe(true);
    expect(res.paymentMethod).toBe('pix');
    expect(res.generatedInstallments).toEqual([]);
  });

  it('marks expense as paid via Credit Card and generates linked monthly installments', async () => {
    const created = (await service.create(
      {
        name: 'Monitor',
        accountTypeId: 'cat-1',
        value: 600,
        dueDate: '2026-11-19',
        isRecurring: false,
      },
      'u-1',
    )) as ExpenseWithStatus;

    const res = await service.markAsPaid(created.id, 'u-1', {
      paymentMethod: 'credito',
      installments: 2,
      firstInstallmentDate: '2026-12-10',
    });

    expect(res.isPaid).toBe(true);
    expect(res.paymentMethod).toBe('credito');
    expect(res.generatedInstallments).toHaveLength(2);
    expect(res.generatedInstallments?.[0].dueDate).toBe('2026-12-10');
    expect(res.generatedInstallments?.[1].dueDate).toBe('2027-01-10');
    expect(res.generatedInstallments?.[0].value).toBe(300);
  });

  it('validates credit card required fields and already-paid guard in markAsPaid', async () => {
    await expect(service.markAsPaid('missing', 'u-1')).rejects.toThrow(
      NotFoundException,
    );

    const paid = (await service.create(
      {
        name: 'Lanche',
        accountTypeId: 'cat-1',
        value: 30,
        dueDate: '2026-11-19',
        isRecurring: false,
        isPaid: true,
        paymentMethod: 'pix',
      },
      'u-1',
    )) as ExpenseWithStatus;
    await expect(service.markAsPaid(paid.id, 'u-1')).rejects.toThrow(
      BadRequestException,
    );

    const pending = (await service.create(
      {
        name: 'Internet',
        accountTypeId: 'cat-1',
        value: 100,
        dueDate: '2026-11-19',
        isRecurring: false,
      },
      'u-1',
    )) as ExpenseWithStatus;
    await expect(
      service.markAsPaid(pending.id, 'u-1', { paymentMethod: 'credito' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.markAsPaid(pending.id, 'u-1', {
        paymentMethod: 'credito',
        installments: 2,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('pays all unpaid credit card items of the target month only', async () => {
    await service.create(
      {
        name: 'Pizza',
        accountTypeId: 'cat-1',
        value: 80,
        dueDate: '2026-12-10',
        isRecurring: false,
        installmentCount: 1,
        paymentMethod: 'credito',
        firstInstallmentDate: '2026-12-10',
      },
      'u-1',
    );
    await service.create(
      {
        name: 'Fone',
        accountTypeId: 'cat-1',
        value: 200,
        dueDate: '2026-12-15',
        isRecurring: false,
        installmentCount: 2,
        paymentMethod: 'credito',
        firstInstallmentDate: '2026-12-15',
      },
      'u-1',
    );
    await service.create(
      {
        name: 'Aluguel',
        accountTypeId: 'cat-1',
        value: 500,
        dueDate: '2026-12-10',
        isRecurring: false,
      },
      'u-1',
    );

    const res = await service.payCreditCardInvoice('u-1', {
      month: '2026-12',
      paymentMethod: 'debito',
    });

    expect(res.month).toBe('2026-12');
    expect(res.paidCount).toBe(2);
    expect(res.totalPaid).toBe(180);
    expect(res.paymentMethod).toBe('debito');
  });

  it('throws NotFoundException when no credit card invoice items exist for month', async () => {
    await expect(
      service.payCreditCardInvoice('u-1', {
        month: '2026-12',
        paymentMethod: 'pix',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('pays selected unpaid expenses in batch and calculates totalPaid accurately', async () => {
    const e1 = (await service.create(
      {
        name: 'Sofá parcela',
        accountTypeId: 'cat-1',
        value: 350.5,
        dueDate: '2026-11-10',
        isRecurring: false,
      },
      'u-1',
    )) as ExpenseWithStatus;
    const e2 = (await service.create(
      {
        name: 'Acordo banco',
        accountTypeId: 'cat-1',
        value: 149.5,
        dueDate: '2026-11-12',
        isRecurring: false,
      },
      'u-1',
    )) as ExpenseWithStatus;
    const alreadyPaid = (await service.create(
      {
        name: 'Café',
        accountTypeId: 'cat-1',
        value: 20,
        dueDate: '2026-11-15',
        isRecurring: false,
        isPaid: true,
        paymentMethod: 'pix',
      },
      'u-1',
    )) as ExpenseWithStatus;

    const batchRes = await service.payBatch('u-1', {
      expenseIds: [e1.id, e2.id, alreadyPaid.id],
      paymentMethod: 'pix',
    });

    expect(batchRes.paidCount).toBe(2);
    expect(batchRes.totalPaid).toBe(500);
    expect(batchRes.paymentMethod).toBe('pix');
    expect(batchRes.paidIds).toEqual([e1.id, e2.id]);
  });

  it('supports partial payment on creation and incremental partial settlements with custom dates and undo payment', async () => {
    const partialOnCreate = (await service.create(
      {
        name: 'Parcela Faculdade',
        accountTypeId: 'cat-1',
        value: 1000,
        dueDate: '2099-12-10',
        isRecurring: false,
        paidAmount: 400,
        paidAt: '2026-11-05',
        paymentMethod: 'pix',
      },
      'u-1',
    )) as ExpenseWithStatus;

    expect(partialOnCreate.isPaid).toBe(false);
    expect(partialOnCreate.isPartiallyPaid).toBe(true);
    expect(partialOnCreate.paidAmount).toBe(400);
    expect(partialOnCreate.remainingAmount).toBe(600);
    expect(partialOnCreate.paidAt).toBe('2026-11-05');
    expect(partialOnCreate.status).toBe('pendente');
    expect(partialOnCreate.payments).toHaveLength(1);

    const secondPart = await service.markAsPaid(partialOnCreate.id, 'u-1', {
      amount: 250,
      paidAt: '2026-11-12',
      paymentMethod: 'debito',
    });

    expect(secondPart.isPaid).toBe(false);
    expect(secondPart.isPartiallyPaid).toBe(true);
    expect(secondPart.paidAmount).toBe(650);
    expect(secondPart.remainingAmount).toBe(350);
    expect(secondPart.payments).toHaveLength(2);
    expect(secondPart.payments[1].paidAt).toBe('2026-11-12');

    // Paying more than remaining balance is rejected
    await expect(
      service.markAsPaid(partialOnCreate.id, 'u-1', {
        amount: 500,
        paidAt: '2026-11-15',
        paymentMethod: 'pix',
      }),
    ).rejects.toThrow(BadRequestException);

    // Undo single payment part
    const afterUndoPart = await service.undoPayment(partialOnCreate.id, 'u-1', {
      paymentId: secondPart.payments[1].id,
    });
    expect(afterUndoPart.isPaid).toBe(false);
    expect(afterUndoPart.paidAmount).toBe(400);
    expect(afterUndoPart.remainingAmount).toBe(600);

    // Settle remaining completely
    const settled = await service.markAsPaid(partialOnCreate.id, 'u-1', {
      paidAt: '2026-11-20',
      paymentMethod: 'dinheiro',
    });
    expect(settled.isPaid).toBe(true);
    expect(settled.isPartiallyPaid).toBe(false);
    expect(settled.paidAmount).toBe(1000);
    expect(settled.remainingAmount).toBe(0);
    expect(settled.status).toBe('pago');

    // Full undo payment restores bill back to open
    const afterFullUndo = await service.undoPayment(partialOnCreate.id, 'u-1');
    expect(afterFullUndo.isPaid).toBe(false);
    expect(afterFullUndo.isPartiallyPaid).toBe(false);
    expect(afterFullUndo.paidAmount).toBe(0);
    expect(afterFullUndo.remainingAmount).toBe(1000);
    expect(afterFullUndo.payments).toEqual([]);
    expect(afterFullUndo.status).toBe('pendente');
  });

  it('stores recurring pixKey, auto-debit, cardBank, cardLast4 and generates/pays card-specific invoice', async () => {
    const autoDebitBill = (await service.create(
      {
        name: 'Internet Fibra',
        accountTypeId: 'cat-1',
        value: 149.9,
        dueDate: '2026-12-10',
        isRecurring: false,
        pixKey: '11999998888',
        isAutoDebit: true,
        cardBank: 'Nubank',
        cardLast4: '4821',
      },
      'u-1',
    )) as { id: string; pixKey?: string | null; isAutoDebit?: boolean; cardBank?: string | null; cardLast4?: string | null };

    expect(autoDebitBill.pixKey).toBe('11999998888');
    expect(autoDebitBill.isAutoDebit).toBe(true);
    expect(autoDebitBill.cardBank).toBe('Nubank');
    expect(autoDebitBill.cardLast4).toBe('4821');

    await service.create(
      {
        name: 'Streaming Outro Cartão',
        accountTypeId: 'cat-1',
        value: 50,
        dueDate: '2026-12-10',
        isRecurring: false,
        isCreditCard: true,
        paymentMethod: 'credito',
        cardBank: 'Itaú',
        cardLast4: '9876',
      },
      'u-1',
    );

    const generated = await service.generateCardInvoice('u-1', {
      expenseIds: [autoDebitBill.id],
      dueDate: '2026-12-15',
    });

    expect(generated.generatedCount).toBe(1);
    expect(generated.totalGenerated).toBe(149.9);
    expect(generated.generatedEntries[0].isCreditCard).toBe(true);
    expect(generated.generatedEntries[0].cardBank).toBe('Nubank');
    expect(generated.generatedEntries[0].cardLast4).toBe('4821');
    expect(generated.generatedEntries[0].isAutoDebit).toBe(true);

    // Pay specifically Nubank final 4821 invoice without paying Itaú final 9876
    const paidNubank = await service.payCreditCardInvoice('u-1', {
      month: '2026-12',
      paymentMethod: 'pix',
      cardBank: 'Nubank',
      cardLast4: '4821',
    });

    expect(paidNubank.paidCount).toBe(1);
    expect(paidNubank.totalPaid).toBe(149.9);

    const allExpenses = await service.findAll('u-1', 'individual');
    const itauOpen = allExpenses.find((e) => e.cardLast4 === '9876');
    expect(itauOpen?.isPaid).toBe(false);
  });
});
