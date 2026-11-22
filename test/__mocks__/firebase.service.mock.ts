import { ConflictException } from '@nestjs/common';
import { normalizeCpf } from '../../src/common/cpf.utils';
import {
  computeBlindIndex,
  computeUserBlindIndexes,
  decryptDocumentFromStorage,
  encryptDocumentForStorage,
  getEncryptedFieldNames,
  hasEncryptedCollectionFields,
  isEncryptedCollectionField,
  resolveDocumentOwnerId,
} from '../../src/common/data-crypto.utils';
import {
  FirebaseAuthAccountInfo,
  VerifiedFirebaseToken,
} from '../../src/firebase/firebase.service';
import { COLLECTIONS, UserDoc } from '../../src/firebase/firebase.types';

type StoredDoc = Record<string, unknown>;

export class InMemoryFirebaseService {
  private readonly store = new Map<string, Map<string, StoredDoc>>();
  public verifyFirebaseIdTokenImpl?: (
    idToken: string,
  ) => Promise<VerifiedFirebaseToken>;
  public firebaseAccounts = new Map<string, FirebaseAuthAccountInfo>();
  public deletedFirebaseUids: string[] = [];
  public sentResetEmails: Array<{ email: string; continueUrl?: string }> = [];

  private getCollection(name: string): Map<string, StoredDoc> {
    if (!this.store.has(name)) {
      this.store.set(name, new Map());
    }
    return this.store.get(name)!;
  }

  /** Expõe cópia bruta para inspeção em testes de criptografia em repouso. */
  getRawStoredDoc(collectionName: string, id: string): StoredDoc | null {
    const raw = this.getCollection(collectionName).get(id);
    return raw ? { ...raw } : null;
  }

  private lockKey(namespace: 'lock:email' | 'lock:cpf', value: string): string {
    return computeBlindIndex(namespace, value);
  }

  async findById<T>(collectionName: string, id: string): Promise<T | null> {
    if (!id) return null;
    const item = this.getCollection(collectionName).get(id);
    if (!item) return null;
    return decryptDocumentFromStorage(collectionName, { ...item }) as T;
  }

  async findByField<T>(
    collectionName: string,
    field: string,
    value: string | boolean | number,
  ): Promise<T[]> {
    let queryField = field;
    let queryValue: string | boolean | number = value;

    if (
      collectionName === COLLECTIONS.USERS &&
      field === 'email' &&
      typeof value === 'string'
    ) {
      queryField = 'emailIndex';
      queryValue = computeBlindIndex('user:email', value.trim().toLowerCase());
    } else if (
      collectionName === COLLECTIONS.USERS &&
      field === 'cpf' &&
      typeof value === 'string'
    ) {
      const normalized = normalizeCpf(value);
      if (!normalized) return [];
      queryField = 'cpfIndex';
      queryValue = computeBlindIndex('user:cpf', normalized);
    } else if (isEncryptedCollectionField(collectionName, field)) {
      throw new Error(
        `[SECURITY] Consulta direta não permitida em campo criptografado (${collectionName}.${field}).`,
      );
    }

    const col = this.getCollection(collectionName);
    const out: T[] = [];
    col.forEach((doc) => {
      if (doc[queryField] === queryValue) {
        out.push(
          decryptDocumentFromStorage(collectionName, { ...doc }) as T,
        );
      }
    });
    return out;
  }

  async findOneByField<T>(
    collectionName: string,
    field: string,
    value: string | boolean | number,
  ): Promise<T | null> {
    const matches = await this.findByField<T>(collectionName, field, value);
    return matches[0] ?? null;
  }

  async findByFieldIn<T>(
    collectionName: string,
    field: string,
    values: string[],
  ): Promise<T[]> {
    const set = new Set(values.filter(Boolean));
    if (set.size === 0) return [];
    const col = this.getCollection(collectionName);
    const out: T[] = [];
    col.forEach((doc) => {
      const fieldVal = doc[field];
      if (typeof fieldVal === 'string' && set.has(fieldVal)) {
        out.push(decryptDocumentFromStorage(collectionName, { ...doc }) as T);
      }
    });
    return out;
  }

  async setDoc<T extends { id: string }>(
    collectionName: string,
    doc: T,
  ): Promise<T> {
    const raw: StoredDoc = { ...(doc as unknown as StoredDoc) };
    if (collectionName === COLLECTIONS.USERS) {
      Object.assign(
        raw,
        computeUserBlindIndexes({ email: raw.email, cpf: raw.cpf }),
      );
    }
    const encrypted = encryptDocumentForStorage(collectionName, raw);
    this.getCollection(collectionName).set(doc.id, encrypted);
    return decryptDocumentFromStorage(collectionName, encrypted) as T;
  }

  async updateDoc(
    collectionName: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const col = this.getCollection(collectionName);
    const existing = col.get(id);
    if (!existing) return;

    const encFields = getEncryptedFieldNames(collectionName);
    const touchesEncrypted =
      hasEncryptedCollectionFields(collectionName) &&
      Object.keys(data).some((key) => encFields.includes(key));

    let payloadToMerge: StoredDoc = { ...data };
    if (touchesEncrypted) {
      const ownerId = resolveDocumentOwnerId(collectionName, {
        ...existing,
        ...data,
        id,
      });
      if (collectionName === COLLECTIONS.USERS) {
        Object.assign(
          payloadToMerge,
          computeUserBlindIndexes({ email: data.email, cpf: data.cpf }),
        );
      }
      const encrypted = encryptDocumentForStorage(
        collectionName,
        { ...payloadToMerge, id },
        { recordId: id, ownerId },
      );
      delete encrypted.id;
      payloadToMerge = encrypted;
    }

    col.set(id, { ...existing, ...payloadToMerge });
  }

  async deleteDoc(collectionName: string, id: string): Promise<void> {
    this.getCollection(collectionName).delete(id);
  }

  async verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseToken> {
    if (this.verifyFirebaseIdTokenImpl) {
      return this.verifyFirebaseIdTokenImpl(idToken);
    }
    throw new Error('Token Firebase mock não configurado');
  }

  async lookupFirebaseUser(params: {
    uid?: string;
    email?: string;
  }): Promise<FirebaseAuthAccountInfo | null> {
    if (params.uid) {
      return this.firebaseAccounts.get(params.uid) || null;
    }
    if (params.email) {
      const target = params.email.trim().toLowerCase();
      for (const acc of this.firebaseAccounts.values()) {
        if (acc.email?.toLowerCase() === target) return acc;
      }
    }
    return null;
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
    const current = this.firebaseAccounts.get(uid) || { localId: uid };
    this.firebaseAccounts.set(uid, {
      ...current,
      ...(updates.email ? { email: updates.email } : {}),
      ...(updates.displayName ? { displayName: updates.displayName } : {}),
      ...(updates.password ? { passwordUpdatedAt: Date.now() } : {}),
    });
  }

  async deleteFirebaseUser(uid: string): Promise<void> {
    this.deletedFirebaseUids.push(uid);
    this.firebaseAccounts.delete(uid);
  }

  async sendFirebasePasswordResetEmail(
    email: string,
    continueUrl?: string,
  ): Promise<void> {
    this.sentResetEmails.push({ email, continueUrl });
  }

  async generateFirebasePasswordResetLink(
    email: string,
    _continueUrl?: string,
  ): Promise<string> {
    return `https://painel-monet.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=mock-code-${encodeURIComponent(email)}`;
  }

  async createUserWithAtomicLocks(user: UserDoc): Promise<UserDoc> {
    const emailLocks = this.getCollection(COLLECTIONS.EMAIL_LOCKS);
    const cpfLocks = this.getCollection(COLLECTIONS.CPF_LOCKS);
    const emailKey = this.lockKey('lock:email', user.email);
    const cpfKey = user.cpf ? this.lockKey('lock:cpf', user.cpf) : null;

    if (emailLocks.has(emailKey)) {
      throw new ConflictException({
        message: 'Este e-mail já está cadastrado em outra conta.',
        code: 'EMAIL_ALREADY_EXISTS',
      });
    }
    if (cpfKey && cpfLocks.has(cpfKey)) {
      throw new ConflictException({
        message: 'Este CPF já está cadastrado em outra conta.',
        code: 'CPF_ALREADY_EXISTS',
      });
    }

    emailLocks.set(emailKey, { userId: user.id, updatedAt: user.updatedAt });
    if (cpfKey) {
      cpfLocks.set(cpfKey, { userId: user.id, updatedAt: user.updatedAt });
    }
    const stored = encryptDocumentForStorage(
      COLLECTIONS.USERS,
      {
        ...user,
        ...computeUserBlindIndexes({ email: user.email, cpf: user.cpf }),
      } as StoredDoc,
      { recordId: user.id, ownerId: user.id },
    );
    this.getCollection(COLLECTIONS.USERS).set(user.id, stored);
    return { ...user };
  }

  async updateUserWithAtomicLocks(
    userId: string,
    currentUser: UserDoc,
    updateData: Partial<UserDoc>,
  ): Promise<UserDoc> {
    const emailLocks = this.getCollection(COLLECTIONS.EMAIL_LOCKS);
    const cpfLocks = this.getCollection(COLLECTIONS.CPF_LOCKS);

    const nextEmail = updateData.email ?? currentUser.email;
    const nextCpf =
      updateData.cpf !== undefined ? updateData.cpf : currentUser.cpf;

    if (nextEmail !== currentUser.email) {
      const nextKey = this.lockKey('lock:email', nextEmail);
      const existing = emailLocks.get(nextKey);
      if (existing && existing.userId !== userId) {
        throw new ConflictException({
          message: 'Este e-mail já está vinculado a outra conta.',
          code: 'EMAIL_ALREADY_EXISTS',
        });
      }
      emailLocks.delete(this.lockKey('lock:email', currentUser.email));
      emailLocks.set(nextKey, { userId, updatedAt: updateData.updatedAt });
    }

    if (nextCpf !== currentUser.cpf) {
      if (nextCpf) {
        const nextCpfKey = this.lockKey('lock:cpf', nextCpf);
        const existing = cpfLocks.get(nextCpfKey);
        if (existing && existing.userId !== userId) {
          throw new ConflictException({
            message: 'Este CPF já está cadastrado em outra conta.',
            code: 'CPF_ALREADY_EXISTS',
          });
        }
        if (currentUser.cpf) {
          cpfLocks.delete(this.lockKey('lock:cpf', currentUser.cpf));
        }
        cpfLocks.set(nextCpfKey, { userId, updatedAt: updateData.updatedAt });
      } else if (currentUser.cpf) {
        cpfLocks.delete(this.lockKey('lock:cpf', currentUser.cpf));
      }
    }

    const rawExisting = this.getCollection(COLLECTIONS.USERS).get(userId) || {};
    const encryptedUpdate = encryptDocumentForStorage(
      COLLECTIONS.USERS,
      {
        ...updateData,
        ...computeUserBlindIndexes({ email: nextEmail, cpf: nextCpf }),
        id: userId,
      } as StoredDoc,
      { recordId: userId, ownerId: userId },
    );
    delete encryptedUpdate.id;
    this.getCollection(COLLECTIONS.USERS).set(userId, {
      ...rawExisting,
      ...encryptedUpdate,
    });
    return { ...currentUser, ...updateData };
  }

  async deleteUserAndLocks(user: UserDoc): Promise<void> {
    this.getCollection(COLLECTIONS.USERS).delete(user.id);
    this.getCollection(COLLECTIONS.EMAIL_LOCKS).delete(
      this.lockKey('lock:email', user.email),
    );
    if (user.cpf) {
      this.getCollection(COLLECTIONS.CPF_LOCKS).delete(
        this.lockKey('lock:cpf', user.cpf),
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
