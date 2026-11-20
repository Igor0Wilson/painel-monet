export class InMemoryFirebaseService {
  private readonly store = new Map<string, Map<string, any>>();

  private getCollection(name: string): Map<string, any> {
    if (!this.store.has(name)) {
      this.store.set(name, new Map());
    }
    return this.store.get(name)!;
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

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
