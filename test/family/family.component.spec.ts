import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { BalanceModule } from '../../src/balance/balance.module';
import { ExpensesModule } from '../../src/expenses/expenses.module';
import { FamilyModule } from '../../src/family/family.module';
import { FirebaseModule } from '../../src/firebase/firebase.module';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { IncomeModule } from '../../src/income/income.module';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

function makeCpf(base9: string): string {
  const digits = base9.split('').map(Number);
  let s = 0;
  for (let i = 0; i < 9; i++) s += digits[i] * (10 - i);
  let d1 = (s * 10) % 11;
  if (d1 === 10) d1 = 0;
  digits.push(d1);
  s = 0;
  for (let i = 0; i < 10; i++) s += digits[i] * (11 - i);
  let d2 = (s * 10) % 11;
  if (d2 === 10) d2 = 0;
  digits.push(d2);
  return digits.join('');
}

describe('Family Privacy & Permissions HTTP Component', () => {
  const cpfA = makeCpf('111222333');
  const cpfB = makeCpf('444555666');

  let app: INestApplication;
  let firebase: InMemoryFirebaseService;
  let currentUserId = 'u-a';

  beforeEach(async () => {
    currentUserId = 'u-a';
    firebase = new InMemoryFirebaseService();

    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-a',
      name: 'Alice Silva',
      email: 'alice@test.com',
      cpf: cpfA,
      phone: '11999990001',
      firebaseUid: 'fb-a',
      authProvider: 'password',
      isActive: true,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 500,
      externalEmergencyFund: 0,
      investments: 0,
      externalInvestments: 3000,
      foodAllowance: 400,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-b',
      name: 'Bruno Souza',
      email: 'bruno@test.com',
      cpf: cpfB,
      phone: '11999990002',
      firebaseUid: 'fb-b',
      authProvider: 'password',
      isActive: true,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 200,
      externalEmergencyFund: 0,
      investments: 0,
      externalInvestments: 9000,
      foodAllowance: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await firebase.setDoc(COLLECTIONS.FAMILY_GROUPS, {
      id: 'fam-1',
      name: 'Família Silva',
      createdByUserId: 'u-a',
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.FAMILY_MEMBERS, {
      id: 'u-a',
      familyGroupId: 'fam-1',
      userId: 'u-a',
      userCpf: cpfA,
      role: 'owner',
      createdAt: '2026-01-01',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.FAMILY_MEMBERS, {
      id: 'u-b',
      familyGroupId: 'fam-1',
      userId: 'u-b',
      userCpf: cpfB,
      role: 'member',
      createdAt: '2026-01-02',
      updatedAt: '',
    });

    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-b',
      userId: 'u-b',
      name: 'Salário Bruno',
      value: 8000,
      isRecurring: false,
      incomeDate: '2026-10-05',
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.INVESTMENTS, {
      id: 'inv-b',
      userId: 'u-b',
      name: 'Tesouro Bruno',
      category: 'Tesouro Direto',
      amount: 9000,
      investedDate: '2026-05-10',
      source: 'external',
      createdAt: '',
      updatedAt: '',
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        FirebaseModule,
        FamilyModule,
        BalanceModule,
        IncomeModule,
        ExpensesModule,
      ],
    })
      .overrideProvider(FirebaseService)
      .useValue(firebase)
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
          req.user = { userId: currentUserId, email: `${currentUserId}@test.com` };
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

  it('enforces per-member privacy settings across balance, incomes, and investment items, then restores via fullAccessAll', async () => {
    // Switch actor to Bruno ('u-b') to hide his income and investments from Alice ('u-a')
    currentUserId = 'u-b';
    await request(app.getHttpServer())
      .patch('/family/privacy')
      .send({
        fullAccessAll: false,
        rules: [
          {
            targetUserId: 'u-a',
            viewBalance: false,
            viewIncome: false,
            viewExpenses: true,
            viewInvestments: false,
            viewEmergencyFund: true,
            viewFoodAllowance: true,
          },
        ],
      })
      .expect(200);

    // Switch back to Alice ('u-a') and verify Bruno's income and investments are withheld
    currentUserId = 'u-a';
    const balanceRestricted = await request(app.getHttpServer())
      .get('/balance?scope=family')
      .expect(200);

    expect(balanceRestricted.body.totalIncome).toBe(0);
    expect(balanceRestricted.body.investments).toBe(3000);

    const brunoCard = (balanceRestricted.body.memberBreakdown as Array<{ userId: string; totalIncome: number; investments: number; permissions: { viewIncome: boolean; viewInvestments: boolean } }>).find(
      (m) => m.userId === 'u-b',
    );
    expect(brunoCard?.totalIncome).toBe(0);
    expect(brunoCard?.investments).toBe(0);
    expect(brunoCard?.permissions.viewIncome).toBe(false);
    expect(brunoCard?.permissions.viewInvestments).toBe(false);

    const incomesRestricted = await request(app.getHttpServer())
      .get('/income?scope=family')
      .expect(200);
    expect(incomesRestricted.body).toHaveLength(0);

    const itemsRestricted = await request(app.getHttpServer())
      .get('/balance/investments/items?scope=family')
      .expect(200);
    expect(itemsRestricted.body).toHaveLength(1);
    expect(itemsRestricted.body[0].ownerId).toBe('u-a');

    // Bruno turns fullAccessAll back ON
    currentUserId = 'u-b';
    await request(app.getHttpServer())
      .patch('/family/privacy')
      .send({
        fullAccessAll: true,
        rules: [],
      })
      .expect(200);

    currentUserId = 'u-a';
    const balanceFull = await request(app.getHttpServer())
      .get('/balance?scope=family')
      .expect(200);

    expect(balanceFull.body.totalIncome).toBe(8000);
    expect(balanceFull.body.investments).toBe(12000);
  });
});
