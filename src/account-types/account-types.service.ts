import { Injectable } from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import { FirebaseService } from '../firebase/firebase.service';
import { AccountTypeDoc, COLLECTIONS } from '../firebase/firebase.types';
import { CreateAccountTypeDto } from './dto/create-account-type.dto';

export const DEFAULT_ACCOUNT_TYPES = [
  'Moradia',
  'Compras',
  'Fast Food',
  'Eletrônicos',
  'Cartão de Crédito',
  'Alimentação',
  'Transporte',
  'Saúde',
  'Educação',
  'Lazer',
  'Aluguel',
  'Água',
  'Energia Elétrica',
  'Internet',
];

@Injectable()
export class AccountTypesService {
  constructor(private readonly firebase: FirebaseService) {}

  async findAll(userId: string): Promise<AccountTypeDoc[]> {
    const existing = await this.firebase.findByField<AccountTypeDoc>(
      COLLECTIONS.ACCOUNT_TYPES,
      'userId',
      userId,
    );

    if (existing.length === 0) {
      const now = new Date().toISOString();
      const created = await Promise.all(
        DEFAULT_ACCOUNT_TYPES.map((name) =>
          this.firebase.setDoc<AccountTypeDoc>(COLLECTIONS.ACCOUNT_TYPES, {
            id: uuidv4(),
            name,
            userId,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );
      return created.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    }

    return existing.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  async create(
    dto: CreateAccountTypeDto,
    userId: string,
  ): Promise<AccountTypeDoc> {
    const now = new Date().toISOString();
    return this.firebase.setDoc<AccountTypeDoc>(COLLECTIONS.ACCOUNT_TYPES, {
      id: uuidv4(),
      name: dto.name.trim(),
      userId,
      createdAt: now,
      updatedAt: now,
    });
  }

  async delete(id: string, userId: string): Promise<void> {
    const existing = await this.firebase.findById<AccountTypeDoc>(
      COLLECTIONS.ACCOUNT_TYPES,
      id,
    );
    if (!existing || existing.userId !== userId) return;
    await this.firebase.deleteDoc(COLLECTIONS.ACCOUNT_TYPES, id);
  }
}
