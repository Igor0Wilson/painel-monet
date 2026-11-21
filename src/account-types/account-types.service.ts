import { Injectable } from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import { FirebaseService } from '../firebase/firebase.service';
import { AccountTypeDoc, COLLECTIONS } from '../firebase/firebase.types';
import { CreateAccountTypeDto } from './dto/create-account-type.dto';

export const DEFAULT_ACCOUNT_TYPES = [
  'Transporte',
  'Moradia',
  'Lazer',
  'Alimentação',
  'FastFood',
  'Saúde e Beleza',
  'Móveis e Eletrônicos',
  'Dívidas',
  'Diversos',
];

export function normalizeOfficialCategory(rawName?: string | null): string {
  if (!rawName) return 'Diversos';
  const norm = rawName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  if (
    norm.includes('transporte') ||
    norm.includes('uber') ||
    norm.includes('combustivel') ||
    norm.includes('gasolina') ||
    norm.includes('veiculo')
  ) {
    return 'Transporte';
  }
  if (
    norm.includes('moradia') ||
    norm.includes('aluguel') ||
    norm.includes('agua') ||
    norm.includes('energia') ||
    norm.includes('luz') ||
    norm.includes('internet') ||
    norm.includes('condominio') ||
    norm.includes('casa')
  ) {
    return 'Moradia';
  }
  if (
    norm.includes('lazer') ||
    norm.includes('viagem') ||
    norm.includes('cinema') ||
    norm.includes('streaming')
  ) {
    return 'Lazer';
  }
  if (
    norm.includes('fastfood') ||
    norm.includes('fast food') ||
    norm.includes('fast-food') ||
    norm.includes('lanche') ||
    norm.includes('hamburguer') ||
    norm.includes('delivery') ||
    norm.includes('ifood')
  ) {
    return 'FastFood';
  }
  if (
    norm.includes('alimentacao') ||
    norm.includes('mercado') ||
    norm.includes('supermercado') ||
    norm.includes('feira') ||
    norm.includes('restaurante')
  ) {
    return 'Alimentação';
  }
  if (
    norm.includes('saude') ||
    norm.includes('beleza') ||
    norm.includes('farmacia') ||
    norm.includes('medico') ||
    norm.includes('dentista') ||
    norm.includes('academia') ||
    norm.includes('estetica') ||
    norm.includes('salao') ||
    norm.includes('barbearia') ||
    norm.includes('cosmetico')
  ) {
    return 'Saúde e Beleza';
  }
  if (
    norm.includes('moveis') ||
    norm.includes('movel') ||
    norm.includes('eletron') ||
    norm.includes('eletro') ||
    norm.includes('notebook') ||
    norm.includes('computador') ||
    norm.includes('celular') ||
    norm.includes('geladeira') ||
    norm.includes('sofa') ||
    norm.includes('televisao') ||
    norm.includes('monitor')
  ) {
    return 'Móveis e Eletrônicos';
  }
  if (
    norm.includes('divida') ||
    norm.includes('emprestimo') ||
    norm.includes('financiamento') ||
    norm.includes('acordo') ||
    norm.includes('renegociacao')
  ) {
    return 'Dívidas';
  }
  return 'Diversos';
}

@Injectable()
export class AccountTypesService {
  constructor(private readonly firebase: FirebaseService) {}

  async findAll(userId: string): Promise<AccountTypeDoc[]> {
    const existing = await this.firebase.findByField<AccountTypeDoc>(
      COLLECTIONS.ACCOUNT_TYPES,
      'userId',
      userId,
    );

    const now = new Date().toISOString();
    const byOfficialName = new Map<string, AccountTypeDoc>();

    for (const item of existing) {
      const exactMatch = DEFAULT_ACCOUNT_TYPES.find(
        (cat) => cat.toLowerCase() === item.name.trim().toLowerCase(),
      );
      if (exactMatch && !byOfficialName.has(exactMatch)) {
        byOfficialName.set(exactMatch, { ...item, name: exactMatch });
      } else if (
        item.name.trim().toLowerCase() === 'fast food' &&
        !byOfficialName.has('FastFood')
      ) {
        await this.firebase.updateDoc(COLLECTIONS.ACCOUNT_TYPES, item.id, {
          name: 'FastFood',
          updatedAt: now,
        });
        byOfficialName.set('FastFood', { ...item, name: 'FastFood' });
      }
    }

    const result: AccountTypeDoc[] = [];
    for (const officialName of DEFAULT_ACCOUNT_TYPES) {
      const found = byOfficialName.get(officialName);
      if (found) {
        result.push(found);
      } else {
        const created = await this.firebase.setDoc<AccountTypeDoc>(
          COLLECTIONS.ACCOUNT_TYPES,
          {
            id: uuidv4(),
            name: officialName,
            userId,
            createdAt: now,
            updatedAt: now,
          },
        );
        result.push(created);
      }
    }

    return result;
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
