import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FamilyEventsService } from '../../src/family/family-events.service';
import { FamilyService } from '../../src/family/family.service';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

function makeCpf(base9: string): string {
  const digits = base9.split('').map(Number);
  let s = 0;
  for (let i = 0; i < 9; i++) s += digits[i] * (10 - i);
  let d1 = (s * 10) % 11;
  if (d1 === 10) d1 = 0;
  digits.push(d1);
  s = 0;
  for (let i = 0; i < 10; i++) s += digits[i] * (11 - i);
  let d2 = (s * 10) % 11;
  if (d2 === 10) d2 = 0;
  digits.push(d2);
  return digits.join('');
}

describe('FamilyService (Firestore)', () => {
  const cpfA = makeCpf('123456789');
  const cpfB = makeCpf('987654321');

  let firebase: InMemoryFirebaseService;
  let eventsService: Pick<FamilyEventsService, 'emitToUsers'>;
  let service: FamilyService;

  beforeEach(async () => {
    firebase = new InMemoryFirebaseService();
    eventsService = { emitToUsers: jest.fn() };
    service = new FamilyService(
      firebase as unknown as FirebaseService,
      eventsService as unknown as FamilyEventsService,
    );

    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor',
      email: 'igor@test.com',
      password: 'hash',
      cpf: cpfA,
      phone: '11999990001',
      emergencyFund: 0,
      investments: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-2',
      name: 'Maria',
      email: 'maria@test.com',
      password: 'hash',
      cpf: cpfB,
      phone: '11999990002',
      emergencyFund: 0,
      investments: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  describe('resolveAuthorizedScope (CPF + UserID dual key)', () => {
    it('returns individual scope when requestedScope is not family', async () => {
      const scope = await service.resolveAuthorizedScope('u-1', 'individual');
      expect(scope.mode).toBe('individual');
      expect(scope.userIds).toEqual(['u-1']);
    });

    it('fails closed (403) if user lacks valid CPF or verified family membership', async () => {
      await firebase.updateDoc(COLLECTIONS.USERS, 'u-1', { cpf: null });
      await expect(
        service.resolveAuthorizedScope('u-1', 'family'),
      ).rejects.toThrow(ForbiddenException);

      await firebase.updateDoc(COLLECTIONS.USERS, 'u-1', { cpf: cpfA });
      await expect(
        service.resolveAuthorizedScope('u-1', 'family'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('only includes members whose current user.cpf strictly matches family_members.userCpf', async () => {
      await firebase.setDoc(COLLECTIONS.FAMILY_MEMBERS, {
        id: 'u-1',
        familyGroupId: 'g-1',
        userId: 'u-1',
        userCpf: cpfA,
        role: 'owner',
        createdAt: '',
        updatedAt: '',
      });
      await firebase.setDoc(COLLECTIONS.FAMILY_MEMBERS, {
        id: 'u-2',
        familyGroupId: 'g-1',
        userId: 'u-2',
        userCpf: cpfB,
        role: 'member',
        createdAt: '',
        updatedAt: '',
      });
      await firebase.setDoc(COLLECTIONS.FAMILY_MEMBERS, {
        id: 'u-tampered',
        familyGroupId: 'g-1',
        userId: 'u-tampered',
        userCpf: '00000000000',
        role: 'member',
        createdAt: '',
        updatedAt: '',
      });

      const scope = await service.resolveAuthorizedScope('u-1', 'family');

      expect(scope.mode).toBe('family');
      expect(scope.userIds).toEqual(['u-1', 'u-2']);
      expect(scope.userIds).not.toContain('u-tampered');
    });
  });

  describe('inviteByCpf & acceptInvite (double confirmation)', () => {
    it('rejects invalid CPF, self-invite, and unknown target CPF', async () => {
      await expect(service.inviteByCpf('u-1', '11111111111')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.inviteByCpf('u-1', cpfA)).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.inviteByCpf('u-1', makeCpf('456789123')),
      ).rejects.toThrow(NotFoundException);
    });

    it('enforces double confirmation and binds userId + userCpf on accept', async () => {
      const invite = await service.inviteByCpf('u-1', cpfB);
      expect(invite.inviteeName).toBe('Maria');
      expect(eventsService.emitToUsers).toHaveBeenCalledWith(
        ['u-2', 'u-1'],
        'invite_received',
      );

      await expect(
        service.acceptInvite('u-2', invite.id, false),
      ).rejects.toThrow(BadRequestException);

      const accepted = await service.acceptInvite('u-2', invite.id, true);
      expect(accepted.familyGroupId).toBeDefined();

      const status = await service.getStatus('u-2');
      expect(status.inFamily).toBe(true);
      expect(status.members).toHaveLength(2);

      await expect(service.inviteByCpf('u-1', cpfB)).rejects.toThrow(
        ConflictException,
      );
    });

    it('updates per-member privacy settings and restores fullAccessAll cleanly', async () => {
      const invite = await service.inviteByCpf('u-1', cpfB);
      await service.acceptInvite('u-2', invite.id, true);

      const updatedStatus = await service.updatePrivacy('u-1', {
        fullAccessAll: false,
        rules: [
          {
            targetUserId: 'u-2',
            viewBalance: true,
            viewIncome: false,
            viewExpenses: false,
            viewInvestments: true,
            viewEmergencyFund: false,
            viewFoodAllowance: true,
          },
        ],
      });

      expect(updatedStatus.myPrivacy.fullAccessAll).toBe(false);
      expect(updatedStatus.myPrivacy.rules[0].viewIncome).toBe(false);
      expect(updatedStatus.myPrivacy.rules[0].viewInvestments).toBe(true);

      const scopeForB = await service.resolveAuthorizedScope('u-2', 'family');
      expect(scopeForB.memberPermissions?.get('u-1')).toEqual({
        viewBalance: true,
        viewIncome: false,
        viewExpenses: false,
        viewInvestments: true,
        viewEmergencyFund: false,
        viewFoodAllowance: true,
      });

      await service.updatePrivacy('u-1', { fullAccessAll: true, rules: [] });
      const fullScopeForB = await service.resolveAuthorizedScope('u-2', 'family');
      expect(fullScopeForB.memberPermissions?.get('u-1')?.viewIncome).toBe(true);
    });
  });
});
