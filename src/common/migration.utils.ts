import {
  computeBlindIndex,
  computeUserBlindIndexes,
  decryptDocumentFromStorage,
  encryptDocumentForStorage,
  getEncryptedFieldNames,
  needsReEncryption,
  resolveDocumentOwnerId,
} from './data-crypto.utils';
import { COLLECTIONS } from '../firebase/firebase.types';
import { normalizeCpf } from './cpf.utils';

export interface DocumentMigrationPlan {
  changed: boolean;
  decryptedPreviewKeys: string[];
  nextDoc: Record<string, unknown>;
  userLocksToEnsure?: {
    emailLockId?: string;
    cpfLockId?: string | null;
    userId: string;
  };
}

/**
 * Re-criptografa com segurança um documento legado (`plaintext`, `enc:v1` ou versão antiga `enc:v2:<old>`)
 * para a versão ativa atual de `DATA_ENCRYPTION_KEY`, validando descriptografia round-trip antes de persistir.
 */
export function migrateStoredDocumentRecord(
  collectionName: string,
  rawDoc: Record<string, unknown>,
): DocumentMigrationPlan {
  const requiresUpdate = needsReEncryption(collectionName, rawDoc);
  if (!requiresUpdate) {
    return {
      changed: false,
      decryptedPreviewKeys: [],
      nextDoc: { ...rawDoc },
    };
  }

  const decrypted = decryptDocumentFromStorage(collectionName, { ...rawDoc });
  if (!decrypted) {
    throw new Error(
      `[MIGRATION] Falha ao descriptografar documento em ${collectionName}.`,
    );
  }

  const ownerId = resolveDocumentOwnerId(collectionName, decrypted);
  const recordId = String(decrypted.id || '');
  const encryptedFields = getEncryptedFieldNames(collectionName);
  const cleanClone: Record<string, unknown> = { ...decrypted };

  const nextDoc = encryptDocumentForStorage(collectionName, cleanClone, {
    recordId,
    ownerId,
  });

  if (collectionName === COLLECTIONS.USERS) {
    const indexes = computeUserBlindIndexes({
      email: decrypted.email,
      cpf: decrypted.cpf,
    });
    Object.assign(nextDoc, indexes);
  }

  // Validação obrigatória de ida e volta antes de gravar no Firestore
  const verifyDecrypted = decryptDocumentFromStorage(collectionName, {
    ...nextDoc,
  });
  for (const field of encryptedFields) {
    if (decrypted[field] !== undefined && verifyDecrypted?.[field] !== decrypted[field]) {
      throw new Error(
        `[MIGRATION] Divergência de integridade detectada após re-criptografia de ${collectionName}.${field}.`,
      );
    }
  }

  const plan: DocumentMigrationPlan = {
    changed: true,
    decryptedPreviewKeys: encryptedFields,
    nextDoc,
  };

  if (collectionName === COLLECTIONS.USERS && recordId) {
    const email =
      typeof decrypted.email === 'string' ? decrypted.email.trim().toLowerCase() : '';
    const cpf =
      typeof decrypted.cpf === 'string' ? normalizeCpf(decrypted.cpf) : '';
    plan.userLocksToEnsure = {
      userId: recordId,
      emailLockId: email ? computeBlindIndex('lock:email', email) : undefined,
      cpfLockId: cpf ? computeBlindIndex('lock:cpf', cpf) : null,
    };
  }

  return plan;
}
