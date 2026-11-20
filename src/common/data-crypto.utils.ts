import { createCipheriv, createDecipheriv, createHash, createHmac } from 'crypto';
import { COLLECTIONS } from '../firebase/firebase.types';

const ENC_PREFIX = 'enc:v1:';

const ENCRYPTED_STRING_FIELDS: Record<string, string[]> = {
  [COLLECTIONS.INCOME]: ['name'],
  [COLLECTIONS.EXPENSES]: ['name'],
  [COLLECTIONS.INVESTMENTS]: ['name', 'category', 'notes'],
  [COLLECTIONS.USERS]: ['cpf', 'phone'],
  [COLLECTIONS.FAMILY_MEMBERS]: ['userCpf'],
  [COLLECTIONS.FAMILY_INVITES]: ['inviterCpf', 'inviteeCpf'],
};

const ENCRYPTED_NUMBER_FIELDS: Record<string, string[]> = {
  [COLLECTIONS.INCOME]: ['value'],
  [COLLECTIONS.EXPENSES]: ['value'],
  [COLLECTIONS.INVESTMENTS]: ['amount'],
  [COLLECTIONS.USERS]: [
    'emergencyFund',
    'externalEmergencyFund',
    'investments',
    'externalInvestments',
    'foodAllowance',
  ],
};

function getMasterKey(): Buffer {
  const rawSecret =
    process.env.DATA_ENCRYPTION_KEY?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    process.env.FIREBASE_PRIVATE_KEY?.trim() ||
    'financas-default-master-encryption-key-2026';
  return createHash('sha256').update(rawSecret, 'utf8').digest();
}

export function computeDeterministicHash(value: string): string {
  const key = getMasterKey();
  return createHmac('sha256', key)
    .update(value.trim().toLowerCase(), 'utf8')
    .digest('hex');
}

export function isEncryptedValue(val: unknown): val is string {
  return typeof val === 'string' && val.startsWith(ENC_PREFIX);
}

export function encryptFieldValue(
  collectionName: string,
  fieldName: string,
  rawValue: string | number,
): string {
  const plainText = String(rawValue);
  if (plainText.startsWith(ENC_PREFIX)) {
    return plainText;
  }

  const key = getMasterKey();
  const iv = createHmac('sha256', key)
    .update(`${collectionName}:${fieldName}:${plainText}`, 'utf8')
    .digest()
    .subarray(0, 12);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptFieldValue(rawValue: unknown): string | null {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue !== 'string') return String(rawValue);
  if (!rawValue.startsWith(ENC_PREFIX)) return rawValue;

  const payload = rawValue.slice(ENC_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3) return rawValue;

  try {
    const [ivHex, authTagHex, cipherHex] = parts;
    const key = getMasterKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(cipherHex, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return rawValue;
  }
}

export function isEncryptedCollectionField(
  collectionName: string,
  fieldName: string,
): boolean {
  const strFields = ENCRYPTED_STRING_FIELDS[collectionName] || [];
  const numFields = ENCRYPTED_NUMBER_FIELDS[collectionName] || [];
  return strFields.includes(fieldName) || numFields.includes(fieldName);
}

export function hasUnencryptedSensitiveFields(
  collectionName: string,
  doc: Record<string, unknown> | null | undefined,
): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const strFields = ENCRYPTED_STRING_FIELDS[collectionName] || [];
  const numFields = ENCRYPTED_NUMBER_FIELDS[collectionName] || [];

  for (const field of strFields) {
    const val = doc[field];
    if (val !== undefined && val !== null && val !== '' && !isEncryptedValue(val)) {
      return true;
    }
  }
  for (const field of numFields) {
    const val = doc[field];
    if (val !== undefined && val !== null && !isEncryptedValue(val)) {
      return true;
    }
  }
  return false;
}

export function encryptDocumentForStorage<T extends object>(
  collectionName: string,
  doc: T,
): T {
  if (!doc || typeof doc !== 'object') return doc;
  const strFields = ENCRYPTED_STRING_FIELDS[collectionName] || [];
  const numFields = ENCRYPTED_NUMBER_FIELDS[collectionName] || [];
  if (strFields.length === 0 && numFields.length === 0) return doc;

  const clone: Record<string, unknown> = { ...(doc as Record<string, unknown>) };

  for (const field of strFields) {
    const val = clone[field];
    if (val !== undefined && val !== null && val !== '') {
      clone[field] = encryptFieldValue(collectionName, field, String(val));
    }
  }

  for (const field of numFields) {
    const val = clone[field];
    if (val !== undefined && val !== null) {
      const numeric = typeof val === 'number' ? val : Number(val);
      if (!Number.isNaN(numeric)) {
        clone[field] = encryptFieldValue(collectionName, field, numeric);
      }
    }
  }

  const ownerKey = String(clone.userId || clone.id || '');
  if (ownerKey) {
    clone.securityHash = computeDeterministicHash(
      `${collectionName}:${ownerKey}:${String(clone.id || '')}`,
    );
  }

  return clone as unknown as T;
}

export function decryptDocumentFromStorage<T extends object>(
  collectionName: string,
  doc: T | null | undefined,
): T | null {
  if (!doc || typeof doc !== 'object') return doc ?? null;
  const strFields = ENCRYPTED_STRING_FIELDS[collectionName] || [];
  const numFields = ENCRYPTED_NUMBER_FIELDS[collectionName] || [];
  if (strFields.length === 0 && numFields.length === 0) return doc;

  const clone: Record<string, unknown> = { ...(doc as Record<string, unknown>) };

  for (const field of strFields) {
    const val = clone[field];
    if (val !== undefined && val !== null) {
      clone[field] = decryptFieldValue(val);
    }
  }

  for (const field of numFields) {
    const val = clone[field];
    if (val !== undefined && val !== null) {
      const dec = decryptFieldValue(val);
      const parsed = dec !== null ? Number(dec) : 0;
      clone[field] = Number.isNaN(parsed) ? 0 : parsed;
    }
  }

  return clone as unknown as T;
}
