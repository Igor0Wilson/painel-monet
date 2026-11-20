import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  cert,
  getApps,
  initializeApp,
  ServiceAccount,
} from 'firebase-admin/app';
import {
  CollectionReference,
  Firestore,
  getFirestore,
} from 'firebase-admin/firestore';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private firestoreInstance: Firestore | null = null;

  onModuleInit(): void {
    this.ensureInitialized();
  }

  private loadServiceAccount(): ServiceAccount {
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    if (jsonEnv) {
      const rawJson = jsonEnv.startsWith('{')
        ? jsonEnv
        : Buffer.from(jsonEnv, 'base64').toString('utf8');
      const parsed = JSON.parse(rawJson);
      if (parsed.private_key) {
        parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
      }
      return parsed;
    }

    const filePathEnv = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
    if (filePathEnv) {
      const resolvedPath = path.isAbsolute(filePathEnv)
        ? filePathEnv
        : path.resolve(process.cwd(), filePathEnv);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(
          `Arquivo de Service Account não encontrado em: ${resolvedPath}`,
        );
      }
      const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      if (parsed.private_key) {
        parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
      }
      return parsed;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
    const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY?.trim();

    if (projectId && clientEmail && privateKeyRaw) {
      const cleanedKey = privateKeyRaw
        .replace(/^["']|["']$/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\\n/g, '\n');

      return {
        projectId,
        clientEmail,
        privateKey: cleanedKey,
      };
    }

    try {
      const cwd = process.cwd();
      const autoJsonFile = fs
        .readdirSync(cwd)
        .find(
          (file) =>
            file === 'firebase-service-account.json' ||
            /firebase-adminsdk.*\.json$/i.test(file),
        );
      if (autoJsonFile) {
        const fullPath = path.join(cwd, autoJsonFile);
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (parsed.private_key) {
          parsed.private_key = String(parsed.private_key)
            .replace(/\r\n/g, '\n')
            .replace(/\\n/g, '\n');
        }
        return parsed;
      }
    } catch {
      this.logger.debug(
        'Nenhum arquivo local de credenciais encontrado no diretório atual.',
      );
    }

    throw new Error(
      'Credenciais do Firebase Admin não configuradas. Defina FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_SERVICE_ACCOUNT_JSON ou (FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY).',
    );
  }

  private ensureInitialized(): Firestore {
    if (this.firestoreInstance) {
      return this.firestoreInstance;
    }

    if (getApps().length === 0) {
      const serviceAccount = this.loadServiceAccount();
      const resolvedProjectId =
        process.env.FIREBASE_PROJECT_ID?.trim() || serviceAccount.projectId;
      initializeApp({
        credential: cert(serviceAccount),
        projectId: resolvedProjectId,
      });
      this.logger.log(
        `Firebase Admin inicializado para o projeto: ${resolvedProjectId}`,
      );
    }

    this.firestoreInstance = getFirestore();
    return this.firestoreInstance;
  }

  get db(): Firestore {
    return this.ensureInitialized();
  }

  collection(name: string): CollectionReference {
    return this.db.collection(name);
  }

  async findById<T>(collectionName: string, id: string): Promise<T | null> {
    if (!id) return null;
    const snap = await this.collection(collectionName).doc(id).get();
    if (!snap.exists) return null;
    return snap.data() as T;
  }

  async findByField<T>(
    collectionName: string,
    field: string,
    value: string | boolean | number,
  ): Promise<T[]> {
    const snap = await this.collection(collectionName)
      .where(field, '==', value)
      .get();
    return snap.docs.map((doc) => doc.data() as T);
  }

  async findOneByField<T>(
    collectionName: string,
    field: string,
    value: string | boolean | number,
  ): Promise<T | null> {
    const snap = await this.collection(collectionName)
      .where(field, '==', value)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return snap.docs[0].data() as T;
  }

  async findByFieldIn<T>(
    collectionName: string,
    field: string,
    values: string[],
  ): Promise<T[]> {
    const uniqueValues = Array.from(new Set(values.filter(Boolean)));
    if (uniqueValues.length === 0) return [];
    if (uniqueValues.length === 1) {
      return this.findByField<T>(collectionName, field, uniqueValues[0]);
    }

    const results: T[] = [];
    for (let i = 0; i < uniqueValues.length; i += 30) {
      const chunk = uniqueValues.slice(i, i + 30);
      const snap = await this.collection(collectionName)
        .where(field, 'in', chunk)
        .get();
      snap.docs.forEach((doc) => results.push(doc.data() as T));
    }
    return results;
  }

  async setDoc<T extends { id: string }>(
    collectionName: string,
    doc: T,
  ): Promise<T> {
    await this.collection(collectionName).doc(doc.id).set(doc);
    return doc;
  }

  async updateDoc(
    collectionName: string,
    id: string,
    data: Record<string, any>,
  ): Promise<void> {
    await this.collection(collectionName).doc(id).update(data);
  }

  async deleteDoc(collectionName: string, id: string): Promise<void> {
    await this.collection(collectionName).doc(id).delete();
  }

  async healthCheck(): Promise<boolean> {
    await this.db.listCollections();
    return true;
  }
}
