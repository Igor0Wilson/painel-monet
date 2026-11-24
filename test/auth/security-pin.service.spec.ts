import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { SecurityPinService } from '../../src/auth/security-pin.service';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

describe('SecurityPinService (Access Code PIN + Google Persistence)', () => {
  let firebase: InMemoryFirebaseService;
  let pinService: SecurityPinService;
  const origJwtSecret = process.env.JWT_SECRET;

  beforeEach(async () => {
    process.env.JWT_SECRET =
      'test-jwt-secret-key-with-at-least-32-random-chars-ok';
    firebase = new InMemoryFirebaseService();
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-google-1',
      name: 'Google User',
      email: 'google.user@gmail.com',
      cpf: '52998224725',
      phone: '11999990000',
      firebaseUid: 'fb-google-1',
      authProvider: 'google',
      isActive: true,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 0,
      investments: 0,
      createdAt: '',
      updatedAt: '',
    });
    pinService = new SecurityPinService(firebase as unknown as FirebaseService);
  });

  afterEach(() => {
    if (origJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = origJwtSecret;
    }
  });

  it('stores salted scrypt + AES-256-GCM hash, preserves google authProvider, verifies PIN with signed pinDeviceToken, and invalidates old tokens on removal', async () => {
    const setRes = await pinService.setPin('u-google-1', '4829');
    expect(setRes.hasPin).toBe(true);
    expect(setRes.authProvider).toBe('google');
    expect(setRes.pinDeviceToken).toContain('.');

    const rawUser = firebase.getRawStoredDoc(COLLECTIONS.USERS, 'u-google-1');
    expect(String(rawUser?.securityPinHash)).toMatch(/^scrypt_v1:|^enc:v2:/);
    expect(String(rawUser?.securityPinHash)).not.toContain('4829');

    const status = await pinService.getStatus('u-google-1');
    expect(status.hasPin).toBe(true);
    expect(status.authProvider).toBe('google');

    const loggedUser = await pinService.verifyPinForLogin({
      pinDeviceToken: setRes.pinDeviceToken,
      pin: '4829',
    });
    expect(loggedUser.id).toBe('u-google-1');
    expect(loggedUser.authProvider).toBe('google');

    // Tampered token rejected
    await expect(
      pinService.verifyPinForLogin({
        pinDeviceToken: setRes.pinDeviceToken + 'tamper',
        pin: '4829',
      }),
    ).rejects.toThrow(UnauthorizedException);

    // Changing or removing PIN invalidates previous device token
    await pinService.removePin('u-google-1');
    await expect(
      pinService.verifyPinForLogin({
        pinDeviceToken: setRes.pinDeviceToken,
        pin: '4829',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects non-numeric/short PINs and locks out for 5 minutes after 5 failed attempts', async () => {
    await expect(pinService.setPin('u-google-1', '12')).rejects.toThrow(
      BadRequestException,
    );
    await expect(pinService.setPin('u-google-1', 'abcd')).rejects.toThrow(
      BadRequestException,
    );

    const { pinDeviceToken } = await pinService.setPin('u-google-1', '135790');

    for (let i = 0; i < 4; i++) {
      await expect(
        pinService.verifyPinForLogin({ pinDeviceToken, pin: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    // 5th failure triggers 5-minute lockout
    await expect(
      pinService.verifyPinForLogin({ pinDeviceToken, pin: '000000' }),
    ).rejects.toThrow(/5 minutos/i);

    // Even the correct PIN is rejected while locked
    await expect(
      pinService.verifyPinForLogin({ pinDeviceToken, pin: '135790' }),
    ).rejects.toThrow(/tentativas/i);
  });
});
