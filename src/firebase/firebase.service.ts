import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, createVerify } from 'crypto';
import {
  cert,
  Credential,
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
import { COLLECTIONS, UserDoc } from './firebase.types';

export interface VerifiedFirebaseToken {
  uid: string;
  email: string;
  email_verified: boolean;
  name?: string;
  signInProvider: string;
  authTime: number;
}

export interface FirebaseAuthAccountInfo {
  localId: string;
  email?: string;
  displayName?: string;
  passwordUpdatedAt?: number;
  disabled?: boolean;
  providerUserInfo?: Array<{ providerId?: string }>;
}

const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private firestoreInstance: Firestore | null = null;
  private credentialInstance: Credential | null = null;
  private resolvedProjectId = 'painel-monet';
  private cachedCerts: {
    certs: Record<string, string>;
    expiresAt: number;
  } | null = null;
  private cachedAdminToken: { token: string; expiresAt: number } | null = null;

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
        parsed.private_key = String(parsed.private_key)
          .replace(/\r\n/g, '\n')
          .replace(/\\n/g, '\n');
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
        parsed.private_key = String(parsed.private_key)
          .replace(/\r\n/g, '\n')
          .replace(/\\n/g, '\n');
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

    const serviceAccount = this.loadServiceAccount();
    this.credentialInstance = cert(serviceAccount);
    this.resolvedProjectId =
      process.env.FIREBASE_PROJECT_ID?.trim() ||
      serviceAccount.projectId ||
      (serviceAccount as any).project_id ||
      'painel-monet';

    if (getApps().length === 0) {
      initializeApp({
        credential: this.credentialInstance,
        projectId: this.resolvedProjectId,
      });
      this.logger.log(
        `Firebase Admin inicializado para o projeto: ${this.resolvedProjectId}`,
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

  private lockKey(value: string): string {
    return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  }

  private decodeBase64UrlJson<T>(segment: string): T {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as T;
  }

  private async getGooglePublicCerts(): Promise<Record<string, string>> {
    if (this.cachedCerts && this.cachedCerts.expiresAt > Date.now()) {
      return this.cachedCerts.certs;
    }

    const response = await fetch(GOOGLE_CERTS_URL);
    if (!response.ok) {
      throw new Error(
        `Falha ao buscar certificados públicos do Google (${response.status})`,
      );
    }

    const certs = (await response.json()) as Record<string, string>;
    const cacheControl = response.headers.get('cache-control') || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    const ttlSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;

    this.cachedCerts = {
      certs,
      expiresAt: Date.now() + Math.max(60, ttlSeconds) * 1000,
    };
    return certs;
  }

  private async getAdminAccessToken(): Promise<string> {
    this.ensureInitialized();
    if (
      this.cachedAdminToken &&
      this.cachedAdminToken.expiresAt > Date.now() + 60000
    ) {
      return this.cachedAdminToken.token;
    }

    if (!this.credentialInstance) {
      throw new Error('Credencial do Firebase Admin não inicializada.');
    }

    const accessToken = await this.credentialInstance.getAccessToken();
    this.cachedAdminToken = {
      token: accessToken.access_token,
      expiresAt: Date.now() + (accessToken.expires_in || 3600) * 1000,
    };
    return accessToken.access_token;
  }

  async verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseToken> {
    this.ensureInitialized();
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      throw new Error('Formato de token inválido');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = this.decodeBase64UrlJson<{ alg?: string; kid?: string }>(
      encodedHeader,
    );
    if (header.alg !== 'RS256' || !header.kid) {
      throw new Error('Algoritmo ou identificador de chave inválido');
    }

    const certs = await this.getGooglePublicCerts();
    const publicCert = certs[header.kid];
    if (!publicCert) {
      throw new Error('Certificado público correspondente não encontrado');
    }

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();

    const sigBuffer = Buffer.from(
      encodedSignature.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    if (!verifier.verify(publicCert, sigBuffer)) {
      throw new Error('Assinatura do token Firebase inválida');
    }

    const payload = this.decodeBase64UrlJson<{
      aud?: string;
      iss?: string;
      sub?: string;
      exp?: number;
      iat?: number;
      auth_time?: number;
      email?: string;
      email_verified?: boolean;
      name?: string;
      firebase?: { sign_in_provider?: string };
    }>(encodedPayload);

    const projectId =
      process.env.FIREBASE_PROJECT_ID?.trim() || this.resolvedProjectId;
    const nowSec = Math.floor(Date.now() / 1000);

    if (payload.aud !== projectId) {
      throw new Error('Token emitido para outro projeto Firebase');
    }
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
      throw new Error('Emissor do token Firebase inválido');
    }
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new Error('Identificador de usuário ausente no token');
    }
    if (!payload.exp || payload.exp <= nowSec) {
      throw new Error('Token Firebase expirado');
    }
    if (payload.iat && payload.iat > nowSec + 300) {
      throw new Error('Token Firebase com data de emissão futura inválida');
    }

    return {
      uid: payload.sub,
      email: payload.email || '',
      email_verified: Boolean(payload.email_verified),
      name: payload.name,
      signInProvider: payload.firebase?.sign_in_provider || 'password',
      authTime: payload.auth_time || payload.iat || nowSec,
    };
  }

  async lookupFirebaseUser(params: {
    uid?: string;
    email?: string;
  }): Promise<FirebaseAuthAccountInfo | null> {
    const token = await this.getAdminAccessToken();
    const body: Record<string, string[]> = {};
    if (params.uid) body.localId = [params.uid];
    else if (params.email) body.email = [params.email.trim().toLowerCase()];
    else return null;

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${this.resolvedProjectId}/accounts:lookup`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Falha ao consultar conta no Firebase Auth (${response.status}): ${errText}`,
      );
    }

    const data = (await response.json()) as {
      users?: FirebaseAuthAccountInfo[];
    };
    return data.users?.[0] || null;
  }

  async updateFirebaseUser(
    uid: string,
    updates: {
      password?: string;
      email?: string;
      displayName?: string;
      validSince?: number;
    },
  ): Promise<void> {
    const token = await this.getAdminAccessToken();
    const body: Record<string, any> = { localId: uid };
    if (updates.password !== undefined) body.password = updates.password;
    if (updates.email !== undefined) body.email = updates.email;
    if (updates.displayName !== undefined) {
      body.displayName = updates.displayName;
    }
    if (updates.validSince !== undefined) {
      body.validSince = String(updates.validSince);
    }

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${this.resolvedProjectId}/accounts:update`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Falha ao atualizar conta no Firebase Auth (${response.status}): ${errText}`,
      );
    }
  }

  async deleteFirebaseUser(uid: string): Promise<void> {
    if (!uid) return;
    const token = await this.getAdminAccessToken();
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${this.resolvedProjectId}/accounts:delete`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ localId: uid }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      if (errText.includes('USER_NOT_FOUND')) {
        return;
      }
      throw new Error(
        `Falha ao excluir conta no Firebase Auth (${response.status}): ${errText}`,
      );
    }
  }

  async sendFirebasePasswordResetEmail(
    email: string,
    continueUrl?: string,
  ): Promise<void> {
    const webApiKey = process.env.FIREBASE_WEB_API_KEY?.trim();
    if (!webApiKey) {
      throw new Error(
        'FIREBASE_WEB_API_KEY não configurada no backend para envio de e-mail pelo Firebase.',
      );
    }

    const payload: Record<string, string> = {
      requestType: 'PASSWORD_RESET',
      email: email.trim().toLowerCase(),
    };
    if (continueUrl) {
      payload.continueUrl = continueUrl;
    }

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(webApiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Firebase-Locale': 'pt-BR',
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Falha ao disparar e-mail de redefinição pelo Firebase (${response.status}): ${errText}`,
      );
    }
  }

  async createUserWithAtomicLocks(user: UserDoc): Promise<UserDoc> {
    const db = this.db;
    const emailLockRef = db
      .collection(COLLECTIONS.EMAIL_LOCKS)
      .doc(this.lockKey(user.email));
    const cpfLockRef = user.cpf
      ? db.collection(COLLECTIONS.CPF_LOCKS).doc(this.lockKey(user.cpf))
      : null;
    const userRef = db.collection(COLLECTIONS.USERS).doc(user.id);

    await db.runTransaction(async (tx) => {
      const emailSnap = await tx.get(emailLockRef);
      if (emailSnap.exists) {
        throw new ConflictException({
          message: 'Este e-mail já está cadastrado em outra conta.',
          code: 'EMAIL_ALREADY_EXISTS',
        });
      }

      if (cpfLockRef) {
        const cpfSnap = await tx.get(cpfLockRef);
        if (cpfSnap.exists) {
          throw new ConflictException({
            message: 'Este CPF já está cadastrado em outra conta.',
            code: 'CPF_ALREADY_EXISTS',
          });
        }
      }

      const now = user.updatedAt || new Date().toISOString();
      tx.set(emailLockRef, { userId: user.id, updatedAt: now });
      if (cpfLockRef) {
        tx.set(cpfLockRef, { userId: user.id, updatedAt: now });
      }
      tx.set(userRef, user);
    });

    return user;
  }

  async updateUserWithAtomicLocks(
    userId: string,
    currentUser: UserDoc,
    updateData: Partial<UserDoc>,
  ): Promise<UserDoc> {
    const db = this.db;
    const nextEmail = updateData.email ?? currentUser.email;
    const nextCpf =
      updateData.cpf !== undefined ? updateData.cpf : currentUser.cpf;

    const emailChanged = nextEmail !== currentUser.email;
    const cpfChanged = nextCpf !== currentUser.cpf;

    const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
    const oldEmailLockRef = emailChanged
      ? db
          .collection(COLLECTIONS.EMAIL_LOCKS)
          .doc(this.lockKey(currentUser.email))
      : null;
    const newEmailLockRef = emailChanged
      ? db.collection(COLLECTIONS.EMAIL_LOCKS).doc(this.lockKey(nextEmail))
      : null;
    const oldCpfLockRef =
      cpfChanged && currentUser.cpf
        ? db
            .collection(COLLECTIONS.CPF_LOCKS)
            .doc(this.lockKey(currentUser.cpf))
        : null;
    const newCpfLockRef =
      cpfChanged && nextCpf
        ? db.collection(COLLECTIONS.CPF_LOCKS).doc(this.lockKey(nextCpf))
        : null;

    await db.runTransaction(async (tx) => {
      if (newEmailLockRef) {
        const emailSnap = await tx.get(newEmailLockRef);
        if (emailSnap.exists && emailSnap.data()?.userId !== userId) {
          throw new ConflictException({
            message: 'Este e-mail já está vinculado a outra conta.',
            code: 'EMAIL_ALREADY_EXISTS',
          });
        }
      }

      if (newCpfLockRef) {
        const cpfSnap = await tx.get(newCpfLockRef);
        if (cpfSnap.exists && cpfSnap.data()?.userId !== userId) {
          throw new ConflictException({
            message: 'Este CPF já está cadastrado em outra conta.',
            code: 'CPF_ALREADY_EXISTS',
          });
        }
      }

      const now = updateData.updatedAt || new Date().toISOString();
      if (oldEmailLockRef) {
        tx.delete(oldEmailLockRef);
      }
      if (newEmailLockRef) {
        tx.set(newEmailLockRef, { userId, updatedAt: now });
      }
      if (oldCpfLockRef) {
        tx.delete(oldCpfLockRef);
      }
      if (newCpfLockRef) {
        tx.set(newCpfLockRef, { userId, updatedAt: now });
      }
      tx.update(userRef, updateData as Record<string, any>);
    });

    return { ...currentUser, ...updateData };
  }

  async deleteUserAndLocks(user: UserDoc): Promise<void> {
    const db = this.db;
    const userRef = db.collection(COLLECTIONS.USERS).doc(user.id);
    const emailLockRef = db
      .collection(COLLECTIONS.EMAIL_LOCKS)
      .doc(this.lockKey(user.email));
    const cpfLockRef = user.cpf
      ? db.collection(COLLECTIONS.CPF_LOCKS).doc(this.lockKey(user.cpf))
      : null;

    await db.runTransaction(async (tx) => {
      tx.delete(userRef);
      tx.delete(emailLockRef);
      if (cpfLockRef) {
        tx.delete(cpfLockRef);
      }
    });
  }

  async healthCheck(): Promise<boolean> {
    await this.db.listCollections();
    return true;
  }
}
