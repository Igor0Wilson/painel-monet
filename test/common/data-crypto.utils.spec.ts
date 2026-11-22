import { randomBytes } from 'crypto';
import {
  computeBlindIndex,
  decryptDocumentFromStorage,
  decryptFieldValue,
  decryptMediaBuffer,
  encryptDocumentForStorage,
  encryptFieldValue,
  encryptMediaBuffer,
  extractCiphertextKeyVersion,
  isEncryptedMediaBuffer,
  isEncryptedValue,
  parseAes256Key,
  redactSensitiveText,
  validateEncryptionKeyConfig,
} from '../../src/common/data-crypto.utils';
import { migrateStoredDocumentRecord } from '../../src/common/migration.utils';
import { COLLECTIONS } from '../../src/firebase/firebase.types';

describe('data-crypto.utils (AES-256-GCM + AAD + Key Rotation)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('encrypts and decrypts income records with AES-256-GCM v2 and AAD binding', () => {
    const rawIncome = {
      id: 'inc-1',
      userId: 'user-1',
      name: 'Salário Empresa Tech',
      value: 8500.75,
      incomeDate: '2026-11-05',
      isRecurring: true,
    };

    const stored = encryptDocumentForStorage(COLLECTIONS.INCOME, rawIncome);

    expect(isEncryptedValue(stored.name)).toBe(true);
    expect(String(stored.name).startsWith('enc:v2:k1:')).toBe(true);
    expect(stored.name).not.toContain('Salário');
    expect(isEncryptedValue(stored.value)).toBe(true);
    expect(String(stored.value)).not.toContain('8500');

    const decrypted = decryptDocumentFromStorage(COLLECTIONS.INCOME, stored);
    expect(decrypted?.name).toBe('Salário Empresa Tech');
    expect(decrypted?.value).toBe(8500.75);
  });

  it('generates distinct random 96-bit IVs for identical CPF plaintexts (never deterministic IV)', () => {
    const cpf = '52998224725';
    const enc1 = encryptFieldValue(COLLECTIONS.USERS, 'cpf', cpf, {
      recordId: 'u-1',
      ownerId: 'u-1',
    });
    const enc2 = encryptFieldValue(COLLECTIONS.USERS, 'cpf', cpf, {
      recordId: 'u-1',
      ownerId: 'u-1',
    });

    expect(enc1).not.toBe(enc2);
    expect(enc1).not.toContain(cpf);
    expect(enc2).not.toContain(cpf);

    expect(
      decryptFieldValue(enc1, {
        collectionName: COLLECTIONS.USERS,
        fieldName: 'cpf',
        recordId: 'u-1',
        ownerId: 'u-1',
      }),
    ).toBe(cpf);
    expect(
      decryptFieldValue(enc2, {
        collectionName: COLLECTIONS.USERS,
        fieldName: 'cpf',
        recordId: 'u-1',
        ownerId: 'u-1',
      }),
    ).toBe(cpf);
  });

  it('fails closed when ciphertext, authTag, or AAD context (ownerId/recordId) is tampered', () => {
    const stored = encryptDocumentForStorage(COLLECTIONS.EXPENSES, {
      id: 'exp-1',
      userId: 'owner-a',
      name: 'Aluguel Sigiloso',
      value: 3200,
    });

    // Copia o ciphertext de owner-a para um documento de owner-b -> AAD deve bloquear
    expect(() =>
      decryptDocumentFromStorage(COLLECTIONS.EXPENSES, {
        ...stored,
        userId: 'owner-b',
      }),
    ).toThrow(/autenticação|integridade/i);

    // Adultera 1 caractere do authTag -> GCM tag deve falhar
    const parts = String(stored.name).split(':');
    parts[4] = parts[4].replace(/^./, parts[4][0] === 'a' ? 'b' : 'a');
    expect(() =>
      decryptDocumentFromStorage(COLLECTIONS.EXPENSES, {
        ...stored,
        name: parts.join(':'),
      }),
    ).toThrow(/autenticação|integridade/i);
  });

  it('fails closed when DATA_ENCRYPTION_KEY is missing, invalid, or all-zeros (no fallback key)', () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(() => validateEncryptionKeyConfig()).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() =>
      encryptFieldValue(COLLECTIONS.USERS, 'cpf', '52998224725', {
        recordId: 'u-1',
        ownerId: 'u-1',
      }),
    ).toThrow(/DATA_ENCRYPTION_KEY/);

    expect(() => parseAes256Key('0'.repeat(64), 'DATA_ENCRYPTION_KEY')).toThrow(
      /ausente ou inválida/i,
    );
    expect(() =>
      parseAes256Key(Buffer.alloc(32, 0).toString('base64'), 'DATA_ENCRYPTION_KEY'),
    ).toThrow(/zeros/i);
    expect(() => parseAes256Key('short-key', 'DATA_ENCRYPTION_KEY')).toThrow(
      /Formato inválido/i,
    );
  });

  it('supports zero-downtime key rotation and round-trip migration from k1 to k2', () => {
    const key1 = randomBytes(32).toString('hex');
    const key2 = randomBytes(32).toString('hex');
    const blindKey = randomBytes(32).toString('hex');

    process.env.DATA_ENCRYPTION_KEY = key1;
    process.env.DATA_ENCRYPTION_KEY_VERSION = 'k1';
    process.env.BLIND_INDEX_KEY = blindKey;

    const storedV1Key = encryptDocumentForStorage(COLLECTIONS.USERS, {
      id: 'u-rot',
      name: 'Maria Oliveira',
      email: 'maria@empresa.com',
      cpf: '52998224725',
      phone: '11999998888',
      investments: 15000,
    });

    expect(extractCiphertextKeyVersion(storedV1Key.name)).toBe('k1');

    // Rotaciona para k2 mantendo k1 em DATA_ENCRYPTION_KEY_PREVIOUS
    process.env.DATA_ENCRYPTION_KEY = key2;
    process.env.DATA_ENCRYPTION_KEY_VERSION = 'k2';
    process.env.DATA_ENCRYPTION_KEY_PREVIOUS = `k1:${key1}`;

    const stillReadable = decryptDocumentFromStorage(COLLECTIONS.USERS, storedV1Key);
    expect(stillReadable?.name).toBe('Maria Oliveira');
    expect(stillReadable?.email).toBe('maria@empresa.com');
    expect(stillReadable?.investments).toBe(15000);

    const migration = migrateStoredDocumentRecord(COLLECTIONS.USERS, storedV1Key);
    expect(migration.changed).toBe(true);
    expect(extractCiphertextKeyVersion(migration.nextDoc.name)).toBe('k2');
    expect(migration.nextDoc.emailIndex).toBe(
      computeBlindIndex('user:email', 'maria@empresa.com'),
    );

    // Após migração, remove k1 e valida que k2 lê sozinha
    delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
    const readWithK2Only = decryptDocumentFromStorage(
      COLLECTIONS.USERS,
      migration.nextDoc,
    );
    expect(readWithK2Only?.name).toBe('Maria Oliveira');
    expect(readWithK2Only?.cpf).toBe('52998224725');
  });

  it('computes deterministic keyed blind indexes without exposing plaintext and redacts logs', () => {
    const h1 = computeBlindIndex('user:cpf', '52998224725');
    const h2 = computeBlindIndex('user:cpf', '52998224725');
    const hDiffNs = computeBlindIndex('lock:cpf', '52998224725');

    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(hDiffNs);
    expect(h1).not.toContain('52998224725');

    const redacted = redactSensitiveText(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxIn0.c2lnbmF0dXJl for 123.456.789-00 joao@teste.com',
    );
    expect(redacted).not.toContain('eyJhbGci');
    expect(redacted).not.toContain('123.456.789-00');
    expect(redacted).not.toContain('joao@teste.com');
  });

  it('encrypts expense partial payment history (JSON) and binary media buffers with AAD checks', () => {
    const rawExpense = {
      id: 'exp-enc-1',
      userId: 'user-1',
      accountTypeId: 'cat-1',
      name: 'Aluguel Residencial',
      value: 2000,
      paidAmount: 750,
      payments: [
        { id: 'p-1', amount: 750, paidAt: '2026-11-10', paymentMethod: 'pix' },
      ],
    };

    const encryptedDoc = encryptDocumentForStorage(COLLECTIONS.EXPENSES, rawExpense);
    expect(isEncryptedValue(encryptedDoc.paidAmount)).toBe(true);
    expect(isEncryptedValue(encryptedDoc.payments)).toBe(true);

    const decryptedDoc = decryptDocumentFromStorage(COLLECTIONS.EXPENSES, encryptedDoc);
    expect(decryptedDoc?.paidAmount).toBe(750);
    expect(decryptedDoc?.payments).toEqual(rawExpense.payments);

    const samplePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const encMedia = encryptMediaBuffer(
      samplePng,
      { categoryFolder: 'expenses', ownerId: 'user-1' },
      { mime: 'image/png', ext: 'png' },
    );

    expect(isEncryptedMediaBuffer(encMedia)).toBe(true);
    expect(encMedia.includes(samplePng)).toBe(false);

    const decMedia = decryptMediaBuffer(encMedia, {
      categoryFolder: 'expenses',
      ownerId: 'user-1',
    });
    expect(decMedia.buffer.equals(samplePng)).toBe(true);
    expect(decMedia.mime).toBe('image/png');

    // Wrong owner AAD must fail authentication
    expect(() =>
      decryptMediaBuffer(encMedia, {
        categoryFolder: 'expenses',
        ownerId: 'attacker-user',
      }),
    ).toThrow(/autenticação/i);
  });
});
