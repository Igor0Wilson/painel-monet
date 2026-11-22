import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { UsersService } from '../../src/users/users.service';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

describe('UsersService (Firebase Auth + Firestore)', () => {
  let firebase: InMemoryFirebaseService;
  let service: UsersService;

  beforeEach(() => {
    firebase = new InMemoryFirebaseService();
    service = new UsersService(firebase as unknown as FirebaseService);
  });

  it('rejects duplicate CPF atomically with CPF_ALREADY_EXISTS code', async () => {
    await service.createFromFirebase({
      email: 'um@gmail.com',
      firebaseUid: 'fb-1',
      authProvider: 'password',
      name: 'Usuario Um',
      cpf: '52998224725',
      phone: '11999998888',
    });

    try {
      await service.createFromFirebase({
        email: 'dois@gmail.com',
        firebaseUid: 'fb-2',
        authProvider: 'password',
        name: 'Usuario Dois',
        cpf: '529.982.247-25',
        phone: '11988887777',
      });
      fail('Deveria rejeitar CPF duplicado');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const response = (error as ConflictException).getResponse() as {
        code?: string;
      };
      expect(response.code).toBe('CPF_ALREADY_EXISTS');
    }
  });

  it('rejects invalid CPF on create', async () => {
    await expect(
      service.createFromFirebase({
        email: 'igor@test.com',
        firebaseUid: 'fb-3',
        authProvider: 'password',
        name: 'Igor',
        cpf: '111.111.111-11',
        phone: '11999998888',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when updating unknown user', async () => {
    await expect(
      service.updateProfile('missing', { name: 'Novo' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('blocks CPF changes while user belongs to a family group', async () => {
    const user = await service.createFromFirebase({
      email: 'igor@test.com',
      firebaseUid: 'fb-4',
      authProvider: 'password',
      name: 'Igor',
      cpf: '52998224725',
      phone: '11988887777',
    });
    await firebase.setDoc(COLLECTIONS.FAMILY_MEMBERS, {
      id: 'fm-1',
      familyGroupId: 'fg-1',
      userId: user.id,
      userCpf: '52998224725',
      role: 'owner',
      createdAt: '',
      updatedAt: '',
    });

    await expect(service.updateProfile(user.id, { cpf: '' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('exports full user data backup cleanly', async () => {
    const user = await service.createFromFirebase({
      email: 'backup@gmail.com',
      firebaseUid: 'fb-5',
      authProvider: 'google',
      name: 'Maria',
      cpf: '52998224725',
      phone: '11988887777',
    });
    await firebase.setDoc(COLLECTIONS.EXPENSES, {
      id: 'exp-1',
      userId: user.id,
      name: 'Aluguel',
      value: 1500,
    });

    const exported = await service.exportAccountData(user.id);
    expect(exported.profile.email).toBe('backup@gmail.com');
    expect(exported.summary.totalExpenses).toBe(1);
    expect(exported.expenses).toHaveLength(1);
  });

  it('deactivates account and scrambles Firebase password', async () => {
    const user = await service.createFromFirebase({
      email: 'desativar@gmail.com',
      firebaseUid: 'fb-6',
      authProvider: 'password',
      name: 'Lucas',
      cpf: '52998224725',
      phone: '11988887777',
    });

    await service.deactivateAccount(user.id, true);

    const updated = await service.findById(user.id);
    expect(updated?.isActive).toBe(false);
    expect(updated?.deactivatedAtMs).toBeGreaterThan(0);
    expect(
      firebase.firebaseAccounts.get('fb-6')?.passwordUpdatedAt,
    ).toBeTruthy();
  });

  it('permanently deletes Firestore data, locks and Firebase Auth user', async () => {
    const user = await service.createFromFirebase({
      email: 'excluir@gmail.com',
      firebaseUid: 'fb-7',
      authProvider: 'password',
      name: 'Ana',
      cpf: '52998224725',
      phone: '11988887777',
    });
    await firebase.setDoc(COLLECTIONS.INCOME, {
      id: 'inc-1',
      userId: user.id,
      name: 'Salario',
      value: 5000,
    });
    await firebase.setDoc(COLLECTIONS.INVESTMENTS, {
      id: 'inv-1',
      userId: user.id,
      name: 'Tesouro Selic',
      category: 'Renda Fixa',
      amount: 12000,
      investedDate: '2026-10-01',
      source: 'external',
    });

    await expect(
      service.deleteAccountPermanently(user.id, true, 'ERRADO'),
    ).rejects.toThrow(BadRequestException);

    await service.deleteAccountPermanently(user.id, true, 'EXCLUIR');

    expect(await service.findById(user.id)).toBeNull();
    expect(await firebase.findById(COLLECTIONS.INCOME, 'inc-1')).toBeNull();
    expect(await firebase.findById(COLLECTIONS.INVESTMENTS, 'inv-1')).toBeNull();
    expect(firebase.deletedFirebaseUids).toContain('fb-7');

    const recreated = await service.createFromFirebase({
      email: 'excluir@gmail.com',
      firebaseUid: 'fb-8',
      authProvider: 'password',
      name: 'Ana Nova',
      cpf: '52998224725',
      phone: '11988887777',
    });
    expect(recreated.cpf).toBe('52998224725');
  });
});
