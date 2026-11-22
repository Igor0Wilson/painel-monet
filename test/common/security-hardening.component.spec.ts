import { INestApplication } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { configureApp } from '../../src/app.setup';
import { AuthModule } from '../../src/auth/auth.module';
import { BalanceModule } from '../../src/balance/balance.module';
import { CryptoModule } from '../../src/common/crypto.module';
import { computeBlindIndex, isEncryptedValue } from '../../src/common/data-crypto.utils';
import { FirestoreThrottlerStorage } from '../../src/common/firestore-throttler.storage';
import { ExpensesModule } from '../../src/expenses/expenses.module';
import { FamilyModule } from '../../src/family/family.module';
import { FirebaseModule } from '../../src/firebase/firebase.module';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { AuditLogDoc, COLLECTIONS, UserDoc } from '../../src/firebase/firebase.types';
import { IncomeModule } from '../../src/income/income.module';
import { UsersModule } from '../../src/users/users.module';
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

describe('Security Hardening & LGPD Compliance HTTP Component', () => {
  const cpfA = makeCpf('111222333');
  const cpfB = makeCpf('444555666');

  let app: INestApplication;
  let firebase: InMemoryFirebaseService;
  let jwtService: JwtService;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    firebase = new InMemoryFirebaseService();

    const userA: UserDoc = {
      id: 'sec-user-a',
      name: 'Alice Sigilosa',
      email: 'alice.sec@empresa.com',
      cpf: cpfA,
      phone: '11999991111',
      firebaseUid: 'fb-sec-a',
      authProvider: 'password',
      isActive: true,
      tokenVersion: 1,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 1000,
      externalEmergencyFund: 0,
      investments: 2500,
      externalInvestments: 0,
      foodAllowance: 500,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const userB: UserDoc = {
      id: 'sec-user-b',
      name: 'Bruno Externo',
      email: 'bruno.sec@empresa.com',
      cpf: cpfB,
      phone: '21988882222',
      firebaseUid: 'fb-sec-b',
      authProvider: 'password',
      isActive: true,
      tokenVersion: 1,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 0,
      externalEmergencyFund: 0,
      investments: 0,
      externalInvestments: 0,
      foodAllowance: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await firebase.createUserWithAtomicLocks(userA);
    await firebase.createUserWithAtomicLocks(userB);

    await firebase.setDoc(COLLECTIONS.ACCOUNT_TYPES, {
      id: 'cat-sec-a',
      name: 'Categoria Confidencial',
      userId: userA.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await firebase.setDoc(COLLECTIONS.EXPENSES, {
      id: 'exp-sec-a',
      userId: userA.id,
      accountTypeId: 'cat-sec-a',
      name: 'Despesa Médica Particular',
      value: 950.5,
      dueDate: '2026-12-10',
      isRecurring: false,
      isInstallment: false,
      installmentCount: null,
      installmentNumber: null,
      parentExpenseId: null,
      isPaid: false,
      isCreditCard: false,
      paymentMethod: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-sec-a',
      userId: userA.id,
      name: 'Salário Diretoria',
      value: 18500,
      isRecurring: false,
      incomeDate: '2026-11-05',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await firebase.setDoc(COLLECTIONS.INVESTMENTS, {
      id: 'inv-sec-a',
      userId: userA.id,
      name: 'CDB Liquidez Diária',
      category: 'Renda Fixa',
      amount: 2500,
      investedDate: '2026-11-01',
      source: 'balance',
      notes: 'Reserva sigilosa',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        CryptoModule,
        FirebaseModule,
        PassportModule,
        JwtModule.register({
          secret: process.env.JWT_SECRET,
          signOptions: { algorithm: 'HS256', expiresIn: '1h' },
        }),
        AuthModule,
        UsersModule,
        ExpensesModule,
        IncomeModule,
        BalanceModule,
        FamilyModule,
      ],
    })
      .overrideProvider(FirebaseService)
      .useValue(firebase)
      .compile();

    jwtService = moduleFixture.get(JwtService);
    tokenA = jwtService.sign({ userId: userA.id, tv: 1 });
    tokenB = jwtService.sign({ userId: userB.id, tv: 1 });

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('encrypts all sensitive fields in storage without leaving plaintext PII or financial values', () => {
    const rawUser = firebase.getRawStoredDoc(COLLECTIONS.USERS, 'sec-user-a');
    const rawExpense = firebase.getRawStoredDoc(COLLECTIONS.EXPENSES, 'exp-sec-a');
    const rawIncome = firebase.getRawStoredDoc(COLLECTIONS.INCOME, 'inc-sec-a');
    const rawInvest = firebase.getRawStoredDoc(COLLECTIONS.INVESTMENTS, 'inv-sec-a');
    const rawCat = firebase.getRawStoredDoc(COLLECTIONS.ACCOUNT_TYPES, 'cat-sec-a');

    expect(isEncryptedValue(rawUser?.name)).toBe(true);
    expect(isEncryptedValue(rawUser?.email)).toBe(true);
    expect(isEncryptedValue(rawUser?.cpf)).toBe(true);
    expect(isEncryptedValue(rawUser?.phone)).toBe(true);
    expect(isEncryptedValue(rawUser?.investments)).toBe(true);
    expect(rawUser?.emailIndex).toBe(
      computeBlindIndex('user:email', 'alice.sec@empresa.com'),
    );
    expect(rawUser?.cpfIndex).toBe(computeBlindIndex('user:cpf', cpfA));
    expect(JSON.stringify(rawUser)).not.toContain(cpfA);
    expect(JSON.stringify(rawUser)).not.toContain('alice.sec@empresa.com');

    expect(isEncryptedValue(rawExpense?.name)).toBe(true);
    expect(isEncryptedValue(rawExpense?.value)).toBe(true);
    expect(isEncryptedValue(rawIncome?.name)).toBe(true);
    expect(isEncryptedValue(rawIncome?.value)).toBe(true);
    expect(isEncryptedValue(rawInvest?.name)).toBe(true);
    expect(isEncryptedValue(rawInvest?.notes)).toBe(true);
    expect(isEncryptedValue(rawInvest?.amount)).toBe(true);
    expect(isEncryptedValue(rawCat?.name)).toBe(true);
  });

  it('returns masked PII on GET /users/me and exposes full data only on owner-audited /users/me/profile or POST /users/me/export', async () => {
    const meRes = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(meRes.body.id).toBe('sec-user-a');
    expect(meRes.body.cpf).toBeUndefined();
    expect(meRes.body.phone).toBeUndefined();
    expect(meRes.body.email).toBeUndefined();
    expect(meRes.body.maskedCpf).toBe(`***.${cpfA.slice(3, 6)}.${cpfA.slice(6, 9)}-**`);
    expect(meRes.body.maskedPhone).toBe('(11) *****-1111');
    expect(meRes.body.maskedEmail).toBe('al***@empresa.com');

    const profileRes = await request(app.getHttpServer())
      .get('/users/me/profile')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(profileRes.body.cpf).toBe(cpfA);
    expect(profileRes.body.email).toBe('alice.sec@empresa.com');

    const exportRes = await request(app.getHttpServer())
      .post('/users/me/export')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({})
      .expect(201);
    expect(exportRes.body.securityVerification.userId).toBe('sec-user-a');

    // Rejeita tentativa de exportação com CPF de terceiro no corpo
    await request(app.getHttpServer())
      .post('/users/me/export')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ cpf: cpfB })
      .expect(403);
  });

  it('blocks cross-user IDOR across expenses, income, investments, categories and family scope', async () => {
    await request(app.getHttpServer())
      .patch('/expenses/exp-sec-a/pay')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ paymentMethod: 'pix' })
      .expect(404);

    await request(app.getHttpServer())
      .patch('/expenses/exp-sec-a')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Sequestrado' })
      .expect(404);

    await request(app.getHttpServer())
      .delete('/expenses/exp-sec-a')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);

    await request(app.getHttpServer())
      .post('/expenses')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        name: 'Tentativa IDOR Categoria',
        accountTypeId: 'cat-sec-a',
        value: 10,
        dueDate: '2026-12-10',
        isRecurring: false,
      })
      .expect(403);

    await request(app.getHttpServer())
      .patch('/income/inc-sec-a')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ value: 1 })
      .expect(404);

    await request(app.getHttpServer())
      .delete('/income/inc-sec-a')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);

    await request(app.getHttpServer())
      .patch('/balance/investments/items/inv-sec-a')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ amount: 1 })
      .expect(404);

    await request(app.getHttpServer())
      .delete('/balance/investments/items/inv-sec-a')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);

    await request(app.getHttpServer())
      .get('/balance?scope=family')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);

    const untouched = await firebase.findById<{ name: string }>(
      COLLECTIONS.EXPENSES,
      'exp-sec-a',
    );
    expect(untouched?.name).toBe('Despesa Médica Particular');
  });

  it('rejects unauthenticated requests and revokes active JWT immediately on POST /auth/logout', async () => {
    await request(app.getHttpServer()).get('/users/me').expect(401);

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(201);

    // Token anteriormente válido deve ser recusado imediatamente após logout
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(401);

    // Verifica que houve registro na trilha de auditoria sem vazar JWT ou CPF
    const auditLogs = await firebase.findByField<AuditLogDoc>(
      COLLECTIONS.AUDIT_LOGS,
      'action',
      'auth.logout',
    );
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].actorUserId).toBe('sec-user-a');
    expect(JSON.stringify(auditLogs)).not.toContain(cpfA);
    expect(JSON.stringify(auditLogs)).not.toContain(tokenA);
  });

  it('redacts query params from error paths and enforces security headers', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/me?cpf=${cpfA}`)
      .expect(401);

    expect(res.body.path).toBe('/users/me');
    expect(JSON.stringify(res.body)).not.toContain(cpfA);
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('enforces distributed rate limiter block threshold cleanly', async () => {
    const storage = new FirestoreThrottlerStorage();
    for (let i = 1; i <= 5; i++) {
      const hit = await storage.increment('client-1', 60000, 5, 60000, 'default');
      expect(hit.isBlocked).toBe(false);
    }
    const blocked = await storage.increment('client-1', 60000, 5, 60000, 'default');
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.totalHits).toBe(6);
  });
});
