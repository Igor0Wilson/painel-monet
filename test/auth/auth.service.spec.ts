import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../../src/auth/auth.service';
import { EmailSenderService } from '../../src/auth/email-sender.service';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { UsersService } from '../../src/users/users.service';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

describe('AuthService (100% Firebase Auth + Deactivation/Reactivation)', () => {
  let firebase: InMemoryFirebaseService;
  let usersService: UsersService;
  let jwtService: JwtService;
  let emailSender: EmailSenderService;
  let authService: AuthService;

  beforeEach(() => {
    firebase = new InMemoryFirebaseService();
    usersService = new UsersService(firebase as unknown as FirebaseService);
    jwtService = new JwtService({
      secret: 'test-jwt-secret-key-32-chars-minimum',
      signOptions: { algorithm: 'HS256', expiresIn: '1h' },
    });
    emailSender = new EmailSenderService();
    authService = new AuthService(
      usersService,
      jwtService,
      firebase as unknown as FirebaseService,
      emailSender,
    );
  });

  it('rejects password login when user exists in Firebase Auth but not in our database', async () => {
    firebase.verifyFirebaseIdTokenImpl = async () => ({
      uid: 'fb-only-1',
      email: 'fantasma@gmail.com',
      email_verified: true,
      signInProvider: 'password',
      authTime: Math.floor(Date.now() / 1000),
    });

    await expect(authService.loginWithFirebase('token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('requires profile completion on first Google login', async () => {
    firebase.verifyFirebaseIdTokenImpl = async () => ({
      uid: 'g-1',
      email: 'novo@gmail.com',
      email_verified: true,
      name: 'Novo Usuario',
      signInProvider: 'google.com',
      authTime: Math.floor(Date.now() / 1000),
    });

    const result = (await authService.loginWithFirebase('valid-token')) as {
      requiresProfileCompletion?: boolean;
      googleProfile?: { email: string };
    };
    expect(result.requiresProfileCompletion).toBe(true);
    expect(result.googleProfile?.email).toBe('novo@gmail.com');
  });

  it('rolls back orphan Firebase Auth user when CPF already exists during registration', async () => {
    await usersService.createFromFirebase({
      email: 'existente@gmail.com',
      firebaseUid: 'fb-1',
      authProvider: 'password',
      name: 'Existente',
      cpf: '52998224725',
      phone: '11999991111',
    });

    firebase.verifyFirebaseIdTokenImpl = async () => ({
      uid: 'fb-orphan',
      email: 'outro@gmail.com',
      email_verified: false,
      signInProvider: 'password',
      authTime: Math.floor(Date.now() / 1000),
    });

    await expect(
      authService.registerWithFirebase({
        idToken: 'orphan-token',
        name: 'Outro',
        cpf: '529.982.247-25',
        phone: '11988887777',
      }),
    ).rejects.toThrow(ConflictException);

    expect(firebase.deletedFirebaseUids).toContain('fb-orphan');
  });

  it('blocks deactivated account login until password is reset via Firebase email', async () => {
    const user = await usersService.createFromFirebase({
      email: 'cliente@gmail.com',
      firebaseUid: 'fb-10',
      authProvider: 'password',
      name: 'Cliente',
      cpf: '52998224725',
      phone: '11999991111',
    });

    await usersService.deactivateAccount(user.id, true);

    firebase.verifyFirebaseIdTokenImpl = async () => ({
      uid: 'fb-10',
      email: 'cliente@gmail.com',
      email_verified: true,
      signInProvider: 'google.com',
      authTime: Math.floor(Date.now() / 1000),
    });

    await expect(
      authService.loginWithFirebase('token-deactivated'),
    ).rejects.toThrow(ForbiddenException);

    const resetRes = await authService.requestPasswordResetOrReactivation(
      '529.982.247-25',
      'reactivate',
    );
    expect(resetRes.maskedEmail).toBe('cl***@gmail.com');
    expect(firebase.sentResetEmails[0].email).toBe('cliente@gmail.com');

    firebase.firebaseAccounts.set('fb-10', {
      localId: 'fb-10',
      email: 'cliente@gmail.com',
      passwordUpdatedAt: Date.now() + 5000,
    });

    const loginAfterReset = (await authService.loginWithFirebase(
      'token-after-reset',
    )) as { reactivated?: boolean; access_token?: string };
    expect(loginAfterReset.reactivated).toBe(true);
    expect(loginAfterReset.access_token).toBeTruthy();

    const reloaded = await usersService.findById(user.id);
    expect(reloaded?.isActive).toBe(true);
  });
});
