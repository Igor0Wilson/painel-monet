import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'crypto';
import { COLLECTIONS } from '../firebase/firebase.types';
import { normalizeCpf } from './cpf.utils';

const ENC_V2_PREFIX = 'enc:v2:';
const ENC_V1_PREFIX = 'enc:v1:';
const IV_LENGTH_BYTES = 12; // 96 bits obrigatórios no AES-256-GCM
const AUTH_TAG_LENGTH_BYTES = 16; // 128 bits GCM tag
const KEY_LENGTH_BYTES = 32; // 256 bits obrigatórios
const DEFAULT_KEY_VERSION = 'k1';
const BLIND_INDEX_SALT = Buffer.from('painel-monet-blind-index-v2-salt', 'utf8');
const BLIND_INDEX_INFO = Buffer.from('painel-monet-blind-index-hmac-sha256', 'utf8');

export interface EncryptionAadContext {
  collectionName: string;
  fieldName: string;
  recordId: string;
  ownerId: string;
}

export interface KeyRingConfig {
  activeVersion: string;
  activeKey: Buffer;
  keysByVersion: Map<string, Buffer>;
  blindIndexKey: Buffer;
}

const ENCRYPTED_STRING_FIELDS: Record<string, string[]> = {
  [COLLECTIONS.USERS]: [
    'name',
    'email',
    'cpf',
    'phone',
    'avatarUrl',
    'avatarPublicId',
    'securityPinHash',
  ],
  [COLLECTIONS.ACCOUNT_TYPES]: ['name'],
  [COLLECTIONS.INCOME]: ['name'],
  [COLLECTIONS.EXPENSES]: ['name', 'receiptUrl', 'receiptPublicId', 'pixKey', 'cardBank', 'cardLast4'],
  [COLLECTIONS.INVESTMENTS]: ['name', 'category', 'notes'],
  [COLLECTIONS.FAMILY_MEMBERS]: ['userCpf'],
  [COLLECTIONS.FAMILY_INVITES]: ['inviterCpf', 'inviteeCpf'],
  [COLLECTIONS.BIOMETRIC_CREDENTIALS]: [
    'deviceLabel',
    'publicKeySpkiPem',
    'nativeSecretHex',
  ],
  [COLLECTIONS.BIOMETRIC_CHALLENGES]: ['nonce', 'pendingSecretHex'],
};

const ENCRYPTED_NUMBER_FIELDS: Record<string, string[]> = {
  [COLLECTIONS.INCOME]: ['value'],
  [COLLECTIONS.EXPENSES]: ['value', 'paidAmount', 'discountAmount'],
  [COLLECTIONS.INVESTMENTS]: [
    'amount',
    'principalAmount',
    'allocatedPrincipal',
    'yieldAmount',
  ],
  [COLLECTIONS.USERS]: [
    'emergencyFund',
    'externalEmergencyFund',
    'emergencyFundTotalYield',
    'investments',
    'externalInvestments',
    'foodAllowance',
  ],
};

const ENCRYPTED_JSON_FIELDS: Record<string, string[]> = {
  [COLLECTIONS.EXPENSES]: ['payments', 'monthlyOverrides'],
  [COLLECTIONS.INCOME]: ['monthlyOverrides'],
  [COLLECTIONS.INVESTMENTS]: ['yieldHistory'],
  [COLLECTIONS.USERS]: [
    'vaConfig',
    'vrConfig',
    'emergencyFundYieldHistory',
  ],
};

const MEDIA_BINARY_MAGIC = Buffer.from('PMENC2\0', 'ascii');

export interface MediaEncryptionContext {
  categoryFolder: 'avatars' | 'expenses';
  ownerId: string;
}

export interface DecryptedMediaPayload {
  buffer: Buffer;
  mime: string;
  ext: 'jpg' | 'png' | 'webp' | 'gif';
}

function isKnownPlaceholderSecret(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return (
    normalized.includes('substitua') ||
    normalized.includes('changeme') ||
    normalized.includes('default-master') ||
    normalized.includes('example') ||
    /^0+$/.test(normalized)
  );
}

/**
 * Decodifica uma chave AES-256 (32 bytes exatos) em hex (64 caracteres) ou Base64/Base64URL.
 * Rejeita qualquer chave ausente, curta, com tamanho incorreto ou placeholder.
 */
export function parseAes256Key(rawKey: string | undefined, varName: string): Buffer {
  const trimmed = (rawKey || '').trim().replace(/^["']|["']$/g, '');
  if (!trimmed || isKnownPlaceholderSecret(trimmed)) {
    throw new Error(
      `[SECURITY] ${varName} ausente ou inválida. Configure manualmente uma chave aleatória de 256 bits (32 bytes em hex ou base64) nas variáveis de ambiente privadas da Vercel.`,
    );
  }

  let decoded: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    decoded = Buffer.from(trimmed, 'hex');
  } else {
    const normalizedB64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/=]{43,48}$/.test(normalizedB64)) {
      throw new Error(
        `[SECURITY] Formato inválido em ${varName}. Utilize 64 caracteres hexadecimais ou Base64 equivalente a exatamente 32 bytes (256 bits).`,
      );
    }
    decoded = Buffer.from(normalizedB64, 'base64');
  }

  if (decoded.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `[SECURITY] ${varName} deve ter exatamente 32 bytes (256 bits).`,
    );
  }

  const allZero = decoded.every((byte) => byte === 0);
  if (allZero) {
    throw new Error(`[SECURITY] ${varName} não pode ser composta apenas por zeros.`);
  }

  return decoded;
}

function resolveKeyVersion(rawVersion?: string): string {
  const version = (rawVersion || DEFAULT_KEY_VERSION).trim();
  if (!/^[a-zA-Z0-9_-]{1,16}$/.test(version)) {
    throw new Error(
      '[SECURITY] DATA_ENCRYPTION_KEY_VERSION inválida. Use apenas [a-zA-Z0-9_-] até 16 caracteres.',
    );
  }
  return version;
}

function parsePreviousKeys(
  rawPrevious: string | undefined,
  keysByVersion: Map<string, Buffer>,
): void {
  const trimmed = (rawPrevious || '').trim();
  if (!trimmed) return;

  if (trimmed.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new Error(
        '[SECURITY] DATA_ENCRYPTION_KEY_PREVIOUS em JSON inválido.',
      );
    }
    for (const [ver, keyVal] of Object.entries(parsed)) {
      const validVer = resolveKeyVersion(ver);
      if (typeof keyVal !== 'string') {
        throw new Error(
          `[SECURITY] Valor inválido para versão ${validVer} em DATA_ENCRYPTION_KEY_PREVIOUS.`,
        );
      }
      if (!keysByVersion.has(validVer)) {
        keysByVersion.set(
          validVer,
          parseAes256Key(keyVal, `DATA_ENCRYPTION_KEY_PREVIOUS[${validVer}]`),
        );
      }
    }
    return;
  }

  const entries = trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const sepIdx = entry.indexOf(':');
    if (sepIdx <= 0) {
      throw new Error(
        '[SECURITY] Formato inválido em DATA_ENCRYPTION_KEY_PREVIOUS. Use "versao:chaveHexOuB64" separado por vírgula ou JSON.',
      );
    }
    const ver = resolveKeyVersion(entry.slice(0, sepIdx));
    const keyVal = entry.slice(sepIdx + 1);
    if (!keysByVersion.has(ver)) {
      keysByVersion.set(
        ver,
        parseAes256Key(keyVal, `DATA_ENCRYPTION_KEY_PREVIOUS[${ver}]`),
      );
    }
  }
}

export function isDevelopmentFirebaseEnv(): boolean {
  const raw = (process.env.FIREBASE_ENV || '').trim().toLowerCase();
  return raw === 'development' || raw === 'dev';
}

export function getKeyRingConfig(): KeyRingConfig {
  const isDev = isDevelopmentFirebaseEnv();
  const activeVersion = resolveKeyVersion(
    (isDev ? process.env.DATA_ENCRYPTION_KEY_VERSION_DEV : undefined) ||
    process.env.DATA_ENCRYPTION_KEY_VERSION,
  );
  const activeKeyVarName =
    isDev && process.env.DATA_ENCRYPTION_KEY_DEV?.trim()
      ? 'DATA_ENCRYPTION_KEY_DEV'
      : 'DATA_ENCRYPTION_KEY';
  const activeKeyRaw =
    isDev && process.env.DATA_ENCRYPTION_KEY_DEV?.trim()
      ? process.env.DATA_ENCRYPTION_KEY_DEV
      : process.env.DATA_ENCRYPTION_KEY;
  const activeKey = parseAes256Key(activeKeyRaw, activeKeyVarName);

  const keysByVersion = new Map<string, Buffer>();
  keysByVersion.set(activeVersion, activeKey);
  parsePreviousKeys(
    (isDev ? process.env.DATA_ENCRYPTION_KEY_PREVIOUS_DEV : undefined) ||
    process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
    keysByVersion,
  );

  const explicitBlindKey = (
    (isDev ? process.env.BLIND_INDEX_KEY_DEV : undefined) ||
    process.env.BLIND_INDEX_KEY
  )?.trim();
  const blindKeyVarName =
    isDev && process.env.BLIND_INDEX_KEY_DEV?.trim()
      ? 'BLIND_INDEX_KEY_DEV'
      : 'BLIND_INDEX_KEY';
  const blindIndexKey = explicitBlindKey
    ? parseAes256Key(explicitBlindKey, blindKeyVarName)
    : Buffer.from(
      hkdfSync(
        'sha256',
        activeKey,
        BLIND_INDEX_SALT,
        BLIND_INDEX_INFO,
        KEY_LENGTH_BYTES,
      ),
    );

  return {
    activeVersion,
    activeKey,
    keysByVersion,
    blindIndexKey,
  };
}

export function validateEncryptionKeyConfig(): {
  activeVersion: string;
  previousVersions: string[];
  dedicatedBlindIndexKey: boolean;
} {
  const ring = getKeyRingConfig();
  return {
    activeVersion: ring.activeVersion,
    previousVersions: Array.from(ring.keysByVersion.keys()).filter(
      (v) => v !== ring.activeVersion,
    ),
    dedicatedBlindIndexKey: Boolean(process.env.BLIND_INDEX_KEY?.trim()),
  };
}

function buildAadBuffer(ctx: EncryptionAadContext): Buffer {
  const col = ctx.collectionName.trim();
  const fld = ctx.fieldName.trim();
  const id = ctx.recordId.trim();
  const own = ctx.ownerId.trim();
  if (!col || !fld || !id || !own) {
    throw new Error(
      `[SECURITY] Contexto AAD incompleto para criptografia AES-256-GCM (${col}.${fld}).`,
    );
  }
  return Buffer.from(`pm:v2|c=${col}|f=${fld}|id=${id}|own=${own}`, 'utf8');
}

export function resolveDocumentOwnerId(
  collectionName: string,
  doc: Record<string, unknown>,
): string {
  const docId = typeof doc.id === 'string' ? doc.id.trim() : '';
  if (collectionName === COLLECTIONS.USERS) {
    return docId;
  }
  if (collectionName === COLLECTIONS.FAMILY_INVITES) {
    const groupId =
      typeof doc.familyGroupId === 'string' ? doc.familyGroupId.trim() : '';
    const inviterId =
      typeof doc.inviterUserId === 'string' ? doc.inviterUserId.trim() : '';
    return groupId || inviterId || docId;
  }
  const userId = typeof doc.userId === 'string' ? doc.userId.trim() : '';
  return userId || docId;
}

export function computeBlindIndex(namespace: string, value: string): string {
  const ring = getKeyRingConfig();
  return createHmac('sha256', ring.blindIndexKey)
    .update(`${namespace}:${value.trim().toLowerCase()}`, 'utf8')
    .digest('hex');
}

export function computeDeterministicHash(value: string): string {
  return computeBlindIndex('hash', value);
}

export function isEncryptedValue(val: unknown): val is string {
  return (
    typeof val === 'string' &&
    (val.startsWith(ENC_V2_PREFIX) || val.startsWith(ENC_V1_PREFIX))
  );
}

export function extractCiphertextKeyVersion(val: unknown): string | null {
  if (typeof val !== 'string' || !val.startsWith(ENC_V2_PREFIX)) {
    return null;
  }
  const parts = val.slice(ENC_V2_PREFIX.length).split(':');
  return parts.length === 4 ? parts[0] : null;
}

export function encryptFieldValue(
  collectionName: string,
  fieldName: string,
  rawValue: string | number,
  aadOverride?: Partial<EncryptionAadContext>,
): string {
  const plainText = String(rawValue);
  if (isEncryptedValue(plainText)) {
    return plainText;
  }

  const ring = getKeyRingConfig();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const recordId = aadOverride?.recordId || 'standalone';
  const ownerId = aadOverride?.ownerId || recordId;

  const aad = buildAadBuffer({
    collectionName,
    fieldName,
    recordId,
    ownerId,
  });

  const cipher = createCipheriv('aes-256-gcm', ring.activeKey, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${ENC_V2_PREFIX}${ring.activeVersion}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptFieldValue(
  storedValue: unknown,
  aadContext?: EncryptionAadContext,
): string | null {
  if (storedValue === null || storedValue === undefined) {
    return null;
  }
  if (typeof storedValue !== 'string') {
    return String(storedValue);
  }

  if (storedValue.startsWith(ENC_V2_PREFIX)) {
    if (!aadContext) {
      throw new Error(
        '[SECURITY] Contexto AAD obrigatório para descriptografar valor AES-256-GCM.',
      );
    }

    const payload = storedValue.slice(ENC_V2_PREFIX.length);
    const parts = payload.split(':');
    if (parts.length !== 4) {
      throw new Error('[SECURITY] Estrutura inválida de dado criptografado v2.');
    }

    const [version, ivHex, tagHex, cipherHex] = parts;
    const ring = getKeyRingConfig();
    const key = ring.keysByVersion.get(version);
    if (!key) {
      throw new Error(
        `[SECURITY] Versão de chave criptográfica '${version}' não encontrada nas variáveis configuradas.`,
      );
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const cipherBytes = Buffer.from(cipherHex, 'hex');

    if (
      iv.length !== IV_LENGTH_BYTES ||
      authTag.length !== AUTH_TAG_LENGTH_BYTES
    ) {
      throw new Error('[SECURITY] Parâmetros IV ou GCM Auth Tag inválidos.');
    }

    const aad = buildAadBuffer(aadContext);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(cipherBytes),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      throw new Error(
        '[SECURITY] Falha de autenticação/integridade AES-256-GCM ao descriptografar campo protegido.',
      );
    }
  }

  if (storedValue.startsWith(ENC_V1_PREFIX)) {
    const parts = storedValue.slice(ENC_V1_PREFIX.length).split(':');
    if (parts.length !== 3) {
      throw new Error('[SECURITY] Estrutura inválida de dado criptografado v1.');
    }
    const [ivHex, tagHex, cipherHex] = parts;
    const ring = getKeyRingConfig();
    const candidateKeys = [
      ring.activeKey,
      ...Array.from(ring.keysByVersion.values()),
    ];
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const cipherBytes = Buffer.from(cipherHex, 'hex');

    for (const candidate of candidateKeys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', candidate, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([
          decipher.update(cipherBytes),
          decipher.final(),
        ]);
        return decrypted.toString('utf8');
      } catch {
        continue;
      }
    }

    throw new Error(
      '[SECURITY] Falha ao autenticar/descriptografar registro legado enc:v1.',
    );
  }

  return storedValue;
}

export function isEncryptedCollectionField(
  collectionName: string,
  fieldName: string,
): boolean {
  const strFields = ENCRYPTED_STRING_FIELDS[collectionName] || [];
  const numFields = ENCRYPTED_NUMBER_FIELDS[collectionName] || [];
  const jsonFields = ENCRYPTED_JSON_FIELDS[collectionName] || [];
  return (
    strFields.includes(fieldName) ||
    numFields.includes(fieldName) ||
    jsonFields.includes(fieldName)
  );
}

export function hasEncryptedCollectionFields(collectionName: string): boolean {
  return (
    (ENCRYPTED_STRING_FIELDS[collectionName]?.length || 0) > 0 ||
    (ENCRYPTED_NUMBER_FIELDS[collectionName]?.length || 0) > 0 ||
    (ENCRYPTED_JSON_FIELDS[collectionName]?.length || 0) > 0
  );
}

export function getEncryptedFieldNames(collectionName: string): string[] {
  return [
    ...(ENCRYPTED_STRING_FIELDS[collectionName] || []),
    ...(ENCRYPTED_NUMBER_FIELDS[collectionName] || []),
    ...(ENCRYPTED_JSON_FIELDS[collectionName] || []),
  ];
}

export function hasUnencryptedSensitiveFields(
  collectionName: string,
  doc: Record<string, unknown> | null | undefined,
): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const strFields = ENCRYPTED_STRING_FIELDS[collectionName] || [];
  const numFields = ENCRYPTED_NUMBER_FIELDS[collectionName] || [];
  const jsonFields = ENCRYPTED_JSON_FIELDS[collectionName] || [];

  for (const field of strFields) {
    const val = doc[field];
    if (
      val !== undefined &&
      val !== null &&
      val !== '' &&
      !isEncryptedValue(val)
    ) {
      return true;
    }
  }
  for (const field of numFields) {
    const val = doc[field];
    if (val !== undefined && val !== null && !isEncryptedValue(val)) {
      return true;
    }
  }
  for (const field of jsonFields) {
    const val = doc[field];
    if (val !== undefined && val !== null && !isEncryptedValue(val)) {
      return true;
    }
  }
  return false;
}

export function needsReEncryption(
  collectionName: string,
  doc: Record<string, unknown> | null | undefined,
): boolean {
  if (!doc || typeof doc !== 'object') return false;
  if (hasUnencryptedSensitiveFields(collectionName, doc)) return true;

  const { activeVersion } = getKeyRingConfig();
  for (const field of getEncryptedFieldNames(collectionName)) {
    const val = doc[field];
    if (typeof val === 'string' && val.startsWith(ENC_V1_PREFIX)) {
      return true;
    }
    const ver = extractCiphertextKeyVersion(val);
    if (ver && ver !== activeVersion) {
      return true;
    }
  }

  if (collectionName === COLLECTIONS.USERS) {
    if (doc.email && !doc.emailIndex) return true;
    if (doc.cpf && !doc.cpfIndex) return true;
  }

  return false;
}

export function computeUserBlindIndexes(userPartial: {
  email?: unknown;
  cpf?: unknown;
}): { emailIndex?: string; cpfIndex?: string | null } {
  const indexes: { emailIndex?: string; cpfIndex?: string | null } = {};
  if (typeof userPartial.email === 'string' && userPartial.email.trim()) {
    indexes.emailIndex = computeBlindIndex(
      'user:email',
      userPartial.email.trim().toLowerCase(),
    );
  }
  if (userPartial.cpf !== undefined) {
    if (typeof userPartial.cpf === 'string' && userPartial.cpf.trim()) {
      const normalized = normalizeCpf(userPartial.cpf);
      indexes.cpfIndex = normalized
        ? computeBlindIndex('user:cpf', normalized)
        : null;
    } else if (userPartial.cpf === null || userPartial.cpf === '') {
      indexes.cpfIndex = null;
    }
  }
  return indexes;
}

export function encryptDocumentForStorage<T extends object>(
  collectionName: string,
  doc: T,
  explicitContext?: { recordId?: string; ownerId?: string },
): T {
  if (!doc || typeof doc !== 'object') return doc;
  const strFields = ENCRYPTED_STRING_FIELDS[collectionName] || [];
  const numFields = ENCRYPTED_NUMBER_FIELDS[collectionName] || [];
  const jsonFields = ENCRYPTED_JSON_FIELDS[collectionName] || [];
  if (strFields.length === 0 && numFields.length === 0 && jsonFields.length === 0) {
    return doc;
  }

  const clone: Record<string, unknown> = {
    ...(doc as Record<string, unknown>),
  };

  const recordId =
    explicitContext?.recordId?.trim() ||
    (typeof clone.id === 'string' ? clone.id.trim() : '');
  const ownerId =
    explicitContext?.ownerId?.trim() ||
    resolveDocumentOwnerId(collectionName, clone);

  if (!recordId || !ownerId) {
    throw new Error(
      `[SECURITY] Identificador de registro/proprietário ausente ao criptografar '${collectionName}'.`,
    );
  }

  if (collectionName === COLLECTIONS.USERS) {
    const indexes = computeUserBlindIndexes({
      email:
        clone.email && !isEncryptedValue(clone.email) ? clone.email : undefined,
      cpf:
        clone.cpf === null || clone.cpf === ''
          ? clone.cpf
          : clone.cpf && !isEncryptedValue(clone.cpf)
            ? clone.cpf
            : undefined,
    });
    if (indexes.emailIndex) clone.emailIndex = indexes.emailIndex;
    if (indexes.cpfIndex !== undefined) clone.cpfIndex = indexes.cpfIndex;
  }

  const ring = getKeyRingConfig();

  for (const field of strFields) {
    const val = clone[field];
    if (val !== undefined && val !== null && val !== '') {
      clone[field] = encryptFieldValue(collectionName, field, String(val), {
        recordId,
        ownerId,
      });
    }
  }

  for (const field of numFields) {
    const val = clone[field];
    if (val !== undefined && val !== null) {
      if (isEncryptedValue(val)) continue;
      const numeric = typeof val === 'number' ? val : Number(val);
      if (!Number.isNaN(numeric)) {
        clone[field] = encryptFieldValue(collectionName, field, numeric, {
          recordId,
          ownerId,
        });
      }
    }
  }

  for (const field of jsonFields) {
    const val = clone[field];
    if (val !== undefined && val !== null && !isEncryptedValue(val)) {
      clone[field] = encryptFieldValue(
        collectionName,
        field,
        JSON.stringify(val),
        {
          recordId,
          ownerId,
        },
      );
    }
  }

  clone.encryptionKeyVersion = ring.activeVersion;
  return clone as unknown as T;
}

export function decryptDocumentFromStorage<T extends object>(
  collectionName: string,
  doc: T | null | undefined,
): T | null {
  if (!doc || typeof doc !== 'object') return doc ?? null;
  const strFields = ENCRYPTED_STRING_FIELDS[collectionName] || [];
  const numFields = ENCRYPTED_NUMBER_FIELDS[collectionName] || [];
  const jsonFields = ENCRYPTED_JSON_FIELDS[collectionName] || [];
  if (strFields.length === 0 && numFields.length === 0 && jsonFields.length === 0) {
    return doc;
  }

  const clone: Record<string, unknown> = {
    ...(doc as Record<string, unknown>),
  };

  const recordId = typeof clone.id === 'string' ? clone.id.trim() : '';
  const ownerId = resolveDocumentOwnerId(collectionName, clone);

  for (const field of strFields) {
    const val = clone[field];
    if (val !== undefined && val !== null) {
      clone[field] = decryptFieldValue(
        val,
        recordId && ownerId
          ? { collectionName, fieldName: field, recordId, ownerId }
          : undefined,
      );
    }
  }

  for (const field of numFields) {
    const val = clone[field];
    if (val !== undefined && val !== null) {
      const dec = decryptFieldValue(
        val,
        recordId && ownerId
          ? { collectionName, fieldName: field, recordId, ownerId }
          : undefined,
      );
      const parsed = dec !== null ? Number(dec) : 0;
      clone[field] = Number.isNaN(parsed) ? 0 : parsed;
    }
  }

  for (const field of jsonFields) {
    const val = clone[field];
    if (val !== undefined && val !== null && typeof val === 'string') {
      const dec = decryptFieldValue(
        val,
        recordId && ownerId
          ? { collectionName, fieldName: field, recordId, ownerId }
          : undefined,
      );
      if (dec) {
        try {
          clone[field] = JSON.parse(dec) as unknown;
        } catch {
          clone[field] = [];
        }
      }
    }
  }

  return clone as unknown as T;
}

function buildMediaAadBuffer(
  ctx: MediaEncryptionContext,
  mime: string,
  ext: string,
): Buffer {
  const cat = ctx.categoryFolder.trim();
  const own = ctx.ownerId.trim();
  if (!cat || !own || !mime || !ext) {
    throw new Error('[SECURITY] Contexto AAD incompleto para criptografia de mídia.');
  }
  return Buffer.from(
    `pm:media:v2|cat=${cat}|own=${own}|mime=${mime}|ext=${ext}`,
    'utf8',
  );
}

export function isEncryptedMediaBuffer(buf: Buffer | null | undefined): boolean {
  return Boolean(
    buf &&
    buf.length > MEDIA_BINARY_MAGIC.length + 2 &&
    buf.subarray(0, MEDIA_BINARY_MAGIC.length).equals(MEDIA_BINARY_MAGIC),
  );
}

/**
 * Criptografa os bytes de imagem com AES-256-GCM (IV 96 bits aleatório, Auth Tag 128 bits
 * e AAD vinculado à pasta de recurso e ao proprietário).
 */
export function encryptMediaBuffer(
  plainBytes: Buffer,
  ctx: MediaEncryptionContext,
  meta: { mime: string; ext: 'jpg' | 'png' | 'webp' | 'gif' },
): Buffer {
  const ring = getKeyRingConfig();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const aad = buildMediaAadBuffer(ctx, meta.mime, meta.ext);

  const cipher = createCipheriv('aes-256-gcm', ring.activeKey, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const headerBuf = Buffer.from(
    JSON.stringify({
      v: ring.activeVersion,
      mime: meta.mime,
      ext: meta.ext,
      iv: iv.toString('hex'),
      tag: authTag.toString('hex'),
    }),
    'utf8',
  );
  const lenBuf = Buffer.allocUnsafe(2);
  lenBuf.writeUInt16BE(headerBuf.length, 0);

  return Buffer.concat([MEDIA_BINARY_MAGIC, lenBuf, headerBuf, encrypted]);
}

/**
 * Descriptografa os bytes de imagem criptografados verificando GCM AuthTag e AAD.
 */
export function decryptMediaBuffer(
  envelope: Buffer,
  ctx: MediaEncryptionContext,
): DecryptedMediaPayload {
  if (!isEncryptedMediaBuffer(envelope)) {
    throw new Error('[SECURITY] Conteúdo de imagem criptografada inválido.');
  }

  const headerLen = envelope.readUInt16BE(MEDIA_BINARY_MAGIC.length);
  const headerStart = MEDIA_BINARY_MAGIC.length + 2;
  const headerEnd = headerStart + headerLen;
  if (headerLen <= 0 || headerEnd > envelope.length) {
    throw new Error('[SECURITY] Cabeçalho inválido de imagem criptografada.');
  }

  let parsed: {
    v?: string;
    mime?: string;
    ext?: 'jpg' | 'png' | 'webp' | 'gif';
    iv?: string;
    tag?: string;
  };
  try {
    parsed = JSON.parse(
      envelope.subarray(headerStart, headerEnd).toString('utf8'),
    ) as typeof parsed;
  } catch {
    throw new Error('[SECURITY] Metadados corrompidos de imagem criptografada.');
  }

  const version = parsed.v || '';
  const mime = parsed.mime || '';
  const ext = parsed.ext;
  if (
    !version ||
    !mime ||
    (ext !== 'jpg' && ext !== 'png' && ext !== 'webp' && ext !== 'gif')
  ) {
    throw new Error('[SECURITY] Tipo de mídia inválido no envelope criptografado.');
  }

  const ring = getKeyRingConfig();
  const key = ring.keysByVersion.get(version);
  if (!key) {
    throw new Error(
      `[SECURITY] Versão de chave criptográfica '${version}' não encontrada para descriptografar mídia.`,
    );
  }

  const iv = Buffer.from(parsed.iv || '', 'hex');
  const authTag = Buffer.from(parsed.tag || '', 'hex');
  if (iv.length !== IV_LENGTH_BYTES || authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error('[SECURITY] Parâmetros IV ou GCM Auth Tag inválidos na mídia.');
  }

  const cipherBytes = envelope.subarray(headerEnd);
  const aad = buildMediaAadBuffer(ctx, mime, ext);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const buffer = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
    return { buffer, mime, ext };
  } catch {
    throw new Error(
      '[SECURITY] Falha de autenticação/integridade AES-256-GCM ao descriptografar mídia.',
    );
  }
}

/**
 * Remove segredos, JWTs, CPFs, e-mails e chaves privadas antes de emitir logs ou erros.
 */
export function redactSensitiveText(input: string): string {
  if (!input) return '';
  return input
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(/Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi, 'Bearer [REDACTED_JWT]')
    .replace(/\beyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/g, '[REDACTED_JWT]')
    .replace(
      /(DATA_ENCRYPTION_KEY|DATA_ENCRYPTION_KEY_PREVIOUS|BLIND_INDEX_KEY|JWT_SECRET|BREVO_API_KEY|RESEND_API_KEY|FIREBASE_PRIVATE_KEY)\s*=\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '***.***.***-**')
    .replace(
      /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
      '$1***@$2',
    );
}
