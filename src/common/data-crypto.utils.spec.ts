import { COLLECTIONS } from '../firebase/firebase.types';
import {
  decryptDocumentFromStorage,
  decryptFieldValue,
  encryptDocumentForStorage,
  encryptFieldValue,
  isEncryptedValue,
} from './data-crypto.utils';

describe('data-crypto.utils', () => {
  it('encrypts and decrypts income (work/salary) names and values so no plaintext is stored in DB', () => {
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
    expect(stored.name).not.toContain('Salário');
    expect(isEncryptedValue(stored.value)).toBe(true);
    expect(String(stored.value)).not.toContain('8500');
    expect(stored.securityHash).toBeDefined();

    const decrypted = decryptDocumentFromStorage(COLLECTIONS.INCOME, stored);
    expect(decrypted?.name).toBe('Salário Empresa Tech');
    expect(decrypted?.value).toBe(8500.75);
  });

  it('produces deterministic ciphertexts for CPF lookups while hiding plaintext', () => {
    const cpf = '52998224725';
    const enc1 = encryptFieldValue(COLLECTIONS.USERS, 'cpf', cpf);
    const enc2 = encryptFieldValue(COLLECTIONS.USERS, 'cpf', cpf);

    expect(enc1).toBe(enc2);
    expect(enc1).not.toContain(cpf);
    expect(decryptFieldValue(enc1)).toBe(cpf);
  });
});
