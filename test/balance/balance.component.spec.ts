import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { BalanceModule } from '../../src/balance/balance.module';
import { FirebaseModule } from '../../src/firebase/firebase.module';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { IncomeModule } from '../../src/income/income.module';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

describe('Balance HTTP Component (Controller + Service + ValidationPipe)', () => {
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
      foodAllowance: 0,
      createdAt: '',
      updatedAt: '',
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [FirebaseModule, BalanceModule, IncomeModule],
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

  it('schedules future VA/VR without crediting balance until creditDate arrives', async () => {
    await request(app.getHttpServer())
      .post('/balance/food-allowance')
      .send({
        amount: 900,
        creditDate: '2099-12-25',
        isRecurring: true,
      })
      .expect(201);

    const balanceFuture = await request(app.getHttpServer())
      .get('/balance?scope=individual')
      .expect(200);

    expect(balanceFuture.body.foodAllowance).toBe(0);
    expect(balanceFuture.body.foodAllowanceScheduled).toBe(900);

    await request(app.getHttpServer())
      .post('/balance/food-allowance')
      .send({
        amount: 900,
        creditDate: '2020-01-05',
        isRecurring: false,
      })
      .expect(201);

    const balanceCredited = await request(app.getHttpServer())
      .get('/balance?scope=individual')
      .expect(200);

    expect(balanceCredited.body.foodAllowance).toBe(900);
    expect(balanceCredited.body.foodAllowanceScheduled).toBe(0);
  });

  it('rejects negative food allowance via DTO ValidationPipe', async () => {
    await request(app.getHttpServer())
      .post('/balance/food-allowance')
      .send({ amount: -10 })
      .expect(400);
  });

  it('allows registering pre-existing investments above available monthly balance', async () => {
    const res = await request(app.getHttpServer())
      .post('/balance/investments')
      .send({ amount: 50000, fromAvailableBalance: false })
      .expect(201);

    expect(res.body.externalInvestments).toBe(50000);
    expect(res.body.investments).toBe(50000);
    expect(res.body.balance).toBe(0);
  });

  it('prevents negative balance when deleting a past income after investing from available balance', async () => {
    const incomeRes = await request(app.getHttpServer())
      .post('/income')
      .send({
        name: 'Saldo Passado QA',
        value: 10000,
        incomeDate: '2026-10-01',
        isRecurring: false,
      })
      .expect(201);

    const createdIncomeId = incomeRes.body.id as string;

    await request(app.getHttpServer())
      .post('/balance/investments')
      .send({ amount: 10000, fromAvailableBalance: true })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/income/${createdIncomeId}`)
      .expect(200);

    const balanceAfterDelete = await request(app.getHttpServer())
      .get('/balance?scope=individual')
      .expect(200);

    expect(balanceAfterDelete.body.balance).toBe(0);
    expect(balanceAfterDelete.body.investments).toBe(10000);
    expect(balanceAfterDelete.body.allocatedInvestments).toBe(0);
    expect(balanceAfterDelete.body.externalInvestments).toBe(10000);
  });
});
