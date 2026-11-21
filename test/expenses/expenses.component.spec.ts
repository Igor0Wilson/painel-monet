import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { ExpensesModule } from '../../src/expenses/expenses.module';
import { FirebaseModule } from '../../src/firebase/firebase.module';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

describe('Expenses HTTP Component (Controller + Service + ValidationPipe)', () => {
  let app: INestApplication;
  let firebase: InMemoryFirebaseService;

  beforeEach(async () => {
    firebase = new InMemoryFirebaseService();
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor Silva',
      email: 'igor@test.com',
      cpf: '52998224725',
      phone: '11999990000',
      firebaseUid: 'fb-1',
      authProvider: 'password',
      isActive: true,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 0,
      investments: 0,
      foodAllowance: 600,
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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [FirebaseModule, ExpensesModule],
    })
      .overrideProvider(FirebaseService)
      .useValue(firebase)
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
          req.user = { userId: 'u-1', email: 'igor@test.com' };
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates an expense and pays it with VR via HTTP pipeline', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/expenses')
      .send({
        name: 'Almoço Restaurante',
        accountTypeId: 'cat-food',
        value: 45.5,
        dueDate: '2026-11-20',
        isRecurring: false,
      })
      .expect(201);

    const createdId = createRes.body.id as string;
    expect(createdId).toBeTruthy();

    const payRes = await request(app.getHttpServer())
      .patch(`/expenses/${createdId}/pay`)
      .send({ paymentMethod: 'vr' })
      .expect(200);

    expect(payRes.body.isPaid).toBe(true);
    expect(payRes.body.paymentMethod).toBe('vr');

    const listRes = await request(app.getHttpServer())
      .get('/expenses?scope=individual')
      .expect(200);

    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].accountType.name).toBe('Alimentação');
    expect(listRes.body[0].status).toBe('pago');
  });

  it('rejects unknown fields (whitelist: true) when creating an expense', async () => {
    await request(app.getHttpServer())
      .post('/expenses')
      .send({
        name: 'Supermercado',
        accountTypeId: 'cat-food',
        value: 100,
        dueDate: '2026-11-20',
        isRecurring: false,
        injectedField: 'malicious',
      })
      .expect(400);
  });

  it('updates a single field on a credit card expense while preserving card and installment data', async () => {
    const createdRes = await request(app.getHttpServer())
      .post('/expenses')
      .send({
        name: 'Compra Cartão',
        accountTypeId: 'cat-food',
        value: 600,
        dueDate: '2026-12-10',
        isRecurring: false,
        isInstallment: true,
        installmentCount: 3,
        isCreditCard: true,
        paymentMethod: 'credito',
      })
      .expect(201);

    const firstInstallment = Array.isArray(createdRes.body)
      ? createdRes.body[0]
      : createdRes.body;

    const patchRes = await request(app.getHttpServer())
      .patch(`/expenses/${firstInstallment.id}`)
      .send({
        name: 'Compra Cartão Editada',
        isCreditCard: true,
        isInstallment: true,
        installmentCount: 3,
      })
      .expect(200);

    expect(patchRes.body.name).toBe('Compra Cartão Editada');
    expect(patchRes.body.isCreditCard).toBe(true);
    expect(patchRes.body.isInstallment).toBe(true);
    expect(patchRes.body.installmentCount).toBe(3);
    expect(patchRes.body.value).toBe(200);
  });

  it('pays selected expenses in batch via POST /expenses/pay-batch', async () => {
    const firstRes = await request(app.getHttpServer())
      .post('/expenses')
      .send({
        name: 'Empréstimo 1',
        accountTypeId: 'cat-food',
        value: 250,
        dueDate: '2026-11-10',
        isRecurring: false,
      })
      .expect(201);

    const secondRes = await request(app.getHttpServer())
      .post('/expenses')
      .send({
        name: 'Notebook parcelado',
        accountTypeId: 'cat-food',
        value: 750,
        dueDate: '2026-11-15',
        isRecurring: false,
      })
      .expect(201);

    const batchRes = await request(app.getHttpServer())
      .post('/expenses/pay-batch')
      .send({
        expenseIds: [firstRes.body.id, secondRes.body.id],
        paymentMethod: 'debito',
      })
      .expect(201);

    expect(batchRes.body.paidCount).toBe(2);
    expect(batchRes.body.totalPaid).toBe(1000);
    expect(batchRes.body.paymentMethod).toBe('debito');
  });
});
