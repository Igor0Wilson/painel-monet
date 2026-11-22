/**
 * Script operacional de migração gradual e rotação de chaves AES-256-GCM no Cloud Firestore.
 *
 * Uso recomendado:
 *   1) Dry-run (somente leitura / relatório):
 *      npx ts-node -r tsconfig-paths/register tools/migrate-encryption-v2.ts --dry-run
 *   2) Execução real com backup prévio obrigatório fora do Firestore:
 *      npx ts-node -r tsconfig-paths/register tools/migrate-encryption-v2.ts --apply --backup-out=./backup-pre-migracao.json
 *
 * Observações:
 * - Durante uma rotação de chave (ex.: k1 -> k2), mantenha a chave antiga configurada em
 *   DATA_ENCRYPTION_KEY_PREVIOUS (ex.: k1:<hex64>) e a nova chave em DATA_ENCRYPTION_KEY + DATA_ENCRYPTION_KEY_VERSION=k2.
 * - NUNCA apague DATA_ENCRYPTION_KEY_PREVIOUS antes de concluir a migração e validar todos os registros em dry-run (0 pendentes).
 */
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { validateEncryptionKeyConfig } from '../src/common/data-crypto.utils';
import { migrateStoredDocumentRecord } from '../src/common/migration.utils';
import { FirebaseService } from '../src/firebase/firebase.service';
import { COLLECTIONS } from '../src/firebase/firebase.types';

const TARGET_COLLECTIONS = [
  COLLECTIONS.USERS,
  COLLECTIONS.ACCOUNT_TYPES,
  COLLECTIONS.INCOME,
  COLLECTIONS.EXPENSES,
  COLLECTIONS.INVESTMENTS,
  COLLECTIONS.FAMILY_MEMBERS,
  COLLECTIONS.FAMILY_INVITES,
] as const;

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const backupArg = args.find((a) => a.startsWith('--backup-out='));
  const backupPath = backupArg ? backupArg.split('=', 2)[1] : '';

  const keyInfo = validateEncryptionKeyConfig();
  console.log(
    `[MIGRATION] Config validada. Ambiente: ${process.env.FIREBASE_ENV || 'production'} | Versão ativa: ${keyInfo.activeVersion} | Versões anteriores carregadas: ${keyInfo.previousVersions.join(', ') || 'nenhuma'} | Modo: ${apply ? 'APPLY' : 'DRY-RUN'}`,
  );

  if (apply && !backupPath) {
    throw new Error(
      'Modo --apply exige --backup-out=<caminho> para gerar snapshot de segurança antes de alterar o Firestore.',
    );
  }

  const firebase = new FirebaseService();
  firebase.onModuleInit();

  const backupSnapshot: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};
  let totalScanned = 0;
  let totalMigrated = 0;

  for (const colName of TARGET_COLLECTIONS) {
    const snap = await firebase.collection(colName).get();
    backupSnapshot[colName] = [];
    let colMigrated = 0;

    for (const docSnap of snap.docs) {
      totalScanned += 1;
      const raw = { ...(docSnap.data() as Record<string, unknown>), id: docSnap.id };
      backupSnapshot[colName].push({ id: docSnap.id, data: raw });

      const plan = migrateStoredDocumentRecord(colName, raw);
      if (!plan.changed) continue;

      colMigrated += 1;
      totalMigrated += 1;

      if (apply) {
        const batch = firebase.db.batch();
        batch.set(firebase.collection(colName).doc(docSnap.id), plan.nextDoc, {
          merge: true,
        });
        if (plan.userLocksToEnsure?.emailLockId) {
          batch.set(
            firebase
              .collection(COLLECTIONS.EMAIL_LOCKS)
              .doc(plan.userLocksToEnsure.emailLockId),
            {
              userId: plan.userLocksToEnsure.userId,
              updatedAt: new Date().toISOString(),
            },
            { merge: true },
          );
        }
        if (plan.userLocksToEnsure?.cpfLockId) {
          batch.set(
            firebase
              .collection(COLLECTIONS.CPF_LOCKS)
              .doc(plan.userLocksToEnsure.cpfLockId),
            {
              userId: plan.userLocksToEnsure.userId,
              updatedAt: new Date().toISOString(),
            },
            { merge: true },
          );
        }
        await batch.commit();
      }
    }

    console.log(
      `[MIGRATION] Coleção '${colName}': lidos=${snap.size}, pendentes_ou_migrados=${colMigrated}`,
    );
  }

  if (apply && backupPath) {
    const resolvedBackup = path.resolve(process.cwd(), backupPath);
    fs.writeFileSync(
      resolvedBackup,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          activeVersion: keyInfo.activeVersion,
          collections: backupSnapshot,
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    console.log(`[MIGRATION] Backup salvo com permissão restrita em: ${resolvedBackup}`);
  }

  console.log(
    `[MIGRATION] Concluído. Total avaliado=${totalScanned}, total ${apply ? 'atualizado' : 'a migrar'}=${totalMigrated}.`,
  );
}

main().catch((err) => {
  console.error(
    '[MIGRATION] Erro fatal:',
    err instanceof Error ? err.message : 'erro desconhecido',
  );
  process.exit(1);
});
