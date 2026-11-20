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

  it('rejects duplicate CPF atomically with CPF_ALREADY_EXISTS code', async () => {
    await service.create({
      name: 'Usuario Um',
      email: 'um@test.com',
      password: 'Password123',
      cpf: '52998224725',
      phone: '11999998888',
    });

    try {
      await service.create({
        name: 'Usuario Dois',
        email: 'dois@test.com',
        password: 'Password123',
        cpf: '529.982.247-25',
        phone: '11988887777',
      });
      fail('Deveria rejeitar CPF duplicado');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const response = (error as ConflictException).getResponse() as any;
      expect(response.code).toBe('CPF_ALREADY_EXISTS');
    }
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

  it('blocks CPF changes while user belongs to a family group', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: '52998224725',
      phone: '11988887777',
      emergencyFund: 0,
      investments: 0,
      createdAt: '',
      updatedAt: '',
    });
    await firebase.setDoc(COLLECTIONS.FAMILY_MEMBERS, {
      id: 'fm-1',
      familyGroupId: 'fg-1',
      userId: 'u-1',
      userCpf: '52998224725',
      role: 'owner',
      createdAt: '',
      updatedAt: '',
    });

    await expect(
      service.updateProfile('u-1', { cpf: '' }),
    ).rejects.toThrow(BadRequestException);
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

  it('creates Google user with mandatory name, CPF and phone', async () => {
    const created = await service.createOrCompleteGoogleUser({
      email: 'maria@gmail.com',
      googleUid: 'google-uid-1',
      name: 'Maria Silva',
      cpf: '529.982.247-25',
      phone: '(11) 97777-6666',
    });

    expect(created.email).toBe('maria@gmail.com');
    expect(created.cpf).toBe('52998224725');
    expect(created.phone).toBe('11977776666');
    expect(created.authProvider).toBe('google');
  });
});
