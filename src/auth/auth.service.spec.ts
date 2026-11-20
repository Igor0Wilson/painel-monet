import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InMemoryFirebaseService } from '../../test/__mocks__/firebase.service.mock';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

describe('AuthService (Google + Recovery)', () => {
  let firebase: InMemoryFirebaseService;
  let usersService: UsersService;
  let jwtService: JwtService;
  let authService: AuthService;

  beforeEach(() => {
    firebase = new InMemoryFirebaseService();
    usersService = new UsersService(firebase as any);
    jwtService = new JwtService({
      secret: 'test-jwt-secret-key-32-chars-minimum',
      signOptions: { algorithm: 'HS256', expiresIn: '1h' },
    });
    authService = new AuthService(usersService, jwtService, firebase as any);
  });

  it('requires profile completion on first Google login', async () => {
    firebase.verifyGoogleIdTokenImpl = async () => ({
      uid: 'g-1',
      email: 'novo@gmail.com',
      email_verified: true,
      name: 'Novo Usuario',
    });

    const result = await authService.loginWithGoogle('valid-google-token');

    expect(result.requiresProfileCompletion).toBe(true);
    expect((result as any).googleProfile.email).toBe('novo@gmail.com');
    expect((result as any).completionToken).toBeTruthy();
  });

  it('completes Google registration and logs in directly on subsequent Google login', async () => {
    firebase.verifyGoogleIdTokenImpl = async () => ({
      uid: 'g-2',
      email: 'cliente@gmail.com',
      email_verified: true,
      name: 'Cliente Gmail',
    });

    const first = (await authService.loginWithGoogle('token-1')) as any;
    const completed = await authService.completeGoogleProfile({
      completionToken: first.completionToken,
      name: 'Cliente Completo',
      cpf: '529.982.247-25',
      phone: '(11) 99999-1111',
    });

    expect(completed.access_token).toBeTruthy();
    expect(completed.user.cpf).toBe('52998224725');

    const second = (await authService.loginWithGoogle('token-2')) as any;
    expect(second.requiresProfileCompletion).toBe(false);
    expect(second.access_token).toBeTruthy();
  });

  it('rejects invalid Google ID tokens', async () => {
    firebase.verifyGoogleIdTokenImpl = async () => {
      throw new Error('invalid token');
    };

    await expect(authService.loginWithGoogle('bad-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('resets password with valid 6-digit recovery code by CPF', async () => {
    await usersService.create({
      name: 'Carlos',
      email: 'carlos@gmail.com',
      password: 'OldPassword1',
      cpf: '52998224725',
      phone: '11999990000',
    });

    const resetReq = (await authService.requestPasswordReset(
      '529.982.247-25',
    )) as any;
    expect(resetReq.maskedEmail).toBe('ca***@gmail.com');
    expect(resetReq.devCode).toHaveLength(6);

    await expect(
      authService.resetPassword({
        identifier: '52998224725',
        code: '000000',
        newPassword: 'NewPassword123',
      }),
    ).rejects.toThrow(BadRequestException);

    const done = await authService.resetPassword({
      identifier: '52998224725',
      code: resetReq.devCode,
      newPassword: 'NewPassword123',
    });
    expect(done.message).toContain('sucesso');

    const loginRes = await authService.login(
      'carlos@gmail.com',
      'NewPassword123',
    );
    expect(loginRes.access_token).toBeTruthy();
  });
});
