import { ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { COLLECTIONS, UserDoc } from '../../src/firebase/firebase.types';

export class InMemoryFirebaseService {
  private readonly store = new Map<string, Map<string, any>>();
  public verifyGoogleIdTokenImpl?: (idToken: string) => Promise<any>;

  private getCollection(name: string): Map<string, any> {
    if (!this.store.has(name)) {
      this.store.set(name, new Map());
    }
    return this.store.get(name)!;
  }

  private lockKey(value: string): string {
    return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  }

  async findById<T>(collectionName: string, id: string): Promise<T | null> {
    if (!id) return null;
    const item = this.getCollection(collectionName).get(id);
    return item ? ({ ...item } as T) : null;
  }

  async findByField<T>(
    collectionName: string,
    field: string,
    value: string | boolean | number,
  ): Promise<T[]> {
    const col = this.getCollection(collectionName);
    const out: T[] = [];
    col.forEach((doc) => {
      if (doc[field] === value) out.push({ ...doc } as T);
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
      if (set.has(doc[field])) out.push({ ...doc } as T);
    });
    return out;
  }

  async setDoc<T extends { id: string }>(
    collectionName: string,
    doc: T,
  ): Promise<T> {
    this.getCollection(collectionName).set(doc.id, { ...doc });
    return { ...doc };
  }

  async updateDoc(
    collectionName: string,
    id: string,
    data: Record<string, any>,
  ): Promise<void> {
    const col = this.getCollection(collectionName);
    const existing = col.get(id);
    if (existing) {
      col.set(id, { ...existing, ...data });
    }
  }

  async deleteDoc(collectionName: string, id: string): Promise<void> {
    this.getCollection(collectionName).delete(id);
  }

  async verifyGoogleIdToken(idToken: string): Promise<any> {
    if (this.verifyGoogleIdTokenImpl) {
      return this.verifyGoogleIdTokenImpl(idToken);
    }
    throw new Error('Token Google mock não configurado');
  }

  async createUserWithAtomicLocks(user: UserDoc): Promise<UserDoc> {
    const emailLocks = this.getCollection(COLLECTIONS.EMAIL_LOCKS);
    const cpfLocks = this.getCollection(COLLECTIONS.CPF_LOCKS);
    const emailKey = this.lockKey(user.email);
    const cpfKey = user.cpf ? this.lockKey(user.cpf) : null;

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
    this.getCollection(COLLECTIONS.USERS).set(user.id, { ...user });
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
      const nextKey = this.lockKey(nextEmail);
      const existing = emailLocks.get(nextKey);
      if (existing && existing.userId !== userId) {
        throw new ConflictException({
          message: 'Este e-mail já está vinculado a outra conta.',
          code: 'EMAIL_ALREADY_EXISTS',
        });
      }
      emailLocks.delete(this.lockKey(currentUser.email));
      emailLocks.set(nextKey, { userId, updatedAt: updateData.updatedAt });
    }

    if (nextCpf !== currentUser.cpf) {
      if (nextCpf) {
        const nextCpfKey = this.lockKey(nextCpf);
        const existing = cpfLocks.get(nextCpfKey);
        if (existing && existing.userId !== userId) {
          throw new ConflictException({
            message: 'Este CPF já está cadastrado em outra conta.',
            code: 'CPF_ALREADY_EXISTS',
          });
        }
        if (currentUser.cpf) {
          cpfLocks.delete(this.lockKey(currentUser.cpf));
        }
        cpfLocks.set(nextCpfKey, { userId, updatedAt: updateData.updatedAt });
      } else if (currentUser.cpf) {
        cpfLocks.delete(this.lockKey(currentUser.cpf));
      }
    }

    const merged = { ...currentUser, ...updateData };
    this.getCollection(COLLECTIONS.USERS).set(userId, merged);
    return { ...merged };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
