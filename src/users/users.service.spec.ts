import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InMemoryFirebaseService } from '../../test/__mocks__/firebase.service.mock';
import { COLLECTIONS } from '../firebase/firebase.types';
import { UsersService } from './users.service';

describe('UsersService (Firestore)', () => {
  let firebase: InMemoryFirebaseService;
  let service: UsersService;

  beforeEach(() => {
    firebase = new InMemoryFirebaseService();
    service = new UsersService(firebase as any);
  });

  it('rejects duplicate email on create', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: null,
      phone: null,
      emergencyFund: 0,
      investments: 0,
      createdAt: '',
      updatedAt: '',
    });

    await expect(
      service.create({
        name: 'Igor',
        email: 'igor@test.com',
        password: 'Password123',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects invalid CPF on create', async () => {
    await expect(
      service.create({
        name: 'Igor',
        email: 'igor@test.com',
        password: 'Password123',
        cpf: '111.111.111-11',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when updating unknown user', async () => {
    await expect(
      service.updateProfile('missing', { name: 'Novo' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('normalizes phone and updates allowed profile fields cleanly', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: null,
      phone: null,
      emergencyFund: 0,
      investments: 0,
      createdAt: '',
      updatedAt: '',
    });

    const updated = await service.updateProfile('u-1', {
      name: '  Igor Silva  ',
      phone: '(11) 98888-7777',
    });

    expect(updated.name).toBe('Igor Silva');
    expect(updated.phone).toBe('11988887777');
    const persisted = await firebase.findById<any>(COLLECTIONS.USERS, 'u-1');
    expect(persisted.phone).toBe('11988887777');
  });
});
