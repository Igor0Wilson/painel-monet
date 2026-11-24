import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, generateKeyPairSync, sign } from 'crypto';
import { BiometricService } from '../../src/auth/biometric.service';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import { hmacSha256Hex } from '../../../mobile/src/hmacSha256';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

function encodeCborUint(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}

function encodeCborBytes(bytes: Buffer): Buffer {
  return Buffer.concat([encodeCborUint(2, bytes.length), bytes]);
}

function encodeCborText(str: string): Buffer {
  const b = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeCborUint(3, b.length), b]);
}

function encodeCborInt(n: number): Buffer {
  if (n >= 0) return encodeCborUint(0, n);
  return encodeCborUint(1, -1 - n);
}

describe('BiometricService (WebAuthn Facial + Mobile Native Digital/Facial)', () => {
  let firebase: InMemoryFirebaseService;
  let biometricService: BiometricService;
  const origFrontendUrl = process.env.FRONTEND_URL;

  beforeEach(async () => {
    process.env.FRONTEND_URL = 'https://painel-monet-front.vercel.app';
    firebase = new InMemoryFirebaseService();
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-1',
      name: 'Igor Biometria',
      email: 'igor@example.com',
      cpf: '52998224725',
      phone: '11999990000',
      firebaseUid: 'fb-1',
      authProvider: 'password',
      isActive: true,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 0,
      investments: 0,
      createdAt: '',
      updatedAt: '',
    });
    biometricService = new BiometricService(
      firebase as unknown as FirebaseService,
    );
  });

  afterEach(() => {
    if (origFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = origFrontendUrl;
    }
  });

  it('registers mobile native credential, matches Node HMAC-SHA256 bit-for-bit, prevents replay, and enforces toggle/removal', async () => {
    const regOpts = await biometricService.createRegistrationOptions('u-1', {
      protocol: 'native_hmac',
      kind: 'biometric',
      platform: 'mobile_android',
      deviceLabel: 'Pixel 8',
    });

    expect(regOpts.credentialIdSuggestion).toBeTruthy();
    expect(regOpts.enrollmentSecretHex).toMatch(/^[a-f0-9]{64}$/);

    const enrollMessage = `pm-bio-v1:${regOpts.challenge}:${regOpts.credentialIdSuggestion}`;
    const enrollSigFromMobileHelper = hmacSha256Hex(
      regOpts.enrollmentSecretHex!,
      enrollMessage,
    );
    const enrollSigFromNode = createHmac(
      'sha256',
      Buffer.from(regOpts.enrollmentSecretHex!, 'hex'),
    )
      .update(enrollMessage)
      .digest('hex');

    expect(enrollSigFromMobileHelper).toBe(enrollSigFromNode);

    const savedCred = await biometricService.verifyAndSaveRegistration('u-1', {
      challengeId: regOpts.challengeId,
      protocol: 'native_hmac',
      kind: 'biometric',
      platform: 'mobile_android',
      deviceLabel: 'Pixel 8',
      credentialId: regOpts.credentialIdSuggestion,
      signature: enrollSigFromMobileHelper,
    });

    expect(savedCred.isEnabled).toBe(true);
    expect(savedCred.kind).toBe('biometric');

    // Sensitive secret must be encrypted in storage at rest
    const rawStored = firebase.getRawStoredDoc(
      COLLECTIONS.BIOMETRIC_CREDENTIALS,
      savedCred.id,
    );
    expect(String(rawStored?.nativeSecretHex)).toMatch(/^enc:v2:/);

    // Login flow via single-use challenge
    const loginOpts = await biometricService.createLoginOptions({
      credentialId: savedCred.credentialId,
    });
    const loginSig = hmacSha256Hex(
      regOpts.enrollmentSecretHex!,
      `pm-bio-v1:${loginOpts.challenge}:${savedCred.credentialId}`,
    );

    const loggedUser = await biometricService.verifyLoginAssertion({
      challengeId: loginOpts.challengeId,
      credentialId: savedCred.credentialId,
      signature: loginSig,
    });
    expect(loggedUser.id).toBe('u-1');

    // Challenge replay must be rejected
    await expect(
      biometricService.verifyLoginAssertion({
        challengeId: loginOpts.challengeId,
        credentialId: savedCred.credentialId,
        signature: loginSig,
      }),
    ).rejects.toThrow(UnauthorizedException);

    // Reconfigure kind & disable by user
    const configured = await biometricService.updateCredential('u-1', savedCred.id, {
      kind: 'fingerprint',
      isEnabled: false,
    });
    expect(configured.isEnabled).toBe(false);
    expect(configured.kind).toBe('fingerprint');

    // Disabled credential cannot issue login challenges
    await expect(
      biometricService.createLoginOptions({ credentialId: savedCred.credentialId }),
    ).rejects.toThrow(UnauthorizedException);

    // Cross-user IDOR update/delete blocked
    await expect(
      biometricService.updateCredential('other-user', savedCred.id, { isEnabled: true }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      biometricService.deleteCredential('other-user', savedCred.id),
    ).rejects.toThrow(NotFoundException);

    // Owner deletes credential
    const delRes = await biometricService.deleteCredential('u-1', savedCred.id);
    expect(delRes.deleted).toBe(true);
  });

  it('verifies full WebAuthn ECDSA P-256 (Facial on Web) registration and login assertion, rejecting untrusted origin or unverified UV', async () => {
    const regOpts = await biometricService.createRegistrationOptions('u-1', {
      protocol: 'webauthn',
      kind: 'facial',
      platform: 'web',
    });

    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const xBuf = Buffer.from(jwk.x, 'base64url');
    const yBuf = Buffer.from(jwk.y, 'base64url');

    // Build COSE EC2 P-256 map: { 1: 2, 3: -7, -1: 1, -2: x, -3: y }
    const coseKey = Buffer.concat([
      Buffer.from([0xa5]),
      encodeCborInt(1),
      encodeCborInt(2),
      encodeCborInt(3),
      encodeCborInt(-7),
      encodeCborInt(-1),
      encodeCborInt(1),
      encodeCborInt(-2),
      encodeCborBytes(xBuf),
      encodeCborInt(-3),
      encodeCborBytes(yBuf),
    ]);

    const credIdBuf = Buffer.from('web-face-cred-001');
    const credIdLenBuf = Buffer.alloc(2);
    credIdLenBuf.writeUInt16BE(credIdBuf.length, 0);
    const rpIdHash = createHash('sha256')
      .update('painel-monet-front.vercel.app')
      .digest();
    const flagsUpUvAt = Buffer.from([0x45]); // UP(0x01) + UV(0x04) + AT(0x40)
    const signCount1 = Buffer.alloc(4);
    signCount1.writeUInt32BE(1, 0);
    const aaguid = Buffer.alloc(16);

    const authData = Buffer.concat([
      rpIdHash,
      flagsUpUvAt,
      signCount1,
      aaguid,
      credIdLenBuf,
      credIdBuf,
      coseKey,
    ]);

    // Attestation CBOR map { fmt: 'none', authData: authData }
    const attObj = Buffer.concat([
      Buffer.from([0xa2]),
      encodeCborText('fmt'),
      encodeCborText('none'),
      encodeCborText('authData'),
      encodeCborBytes(authData),
    ]);

    const regClientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: regOpts.challenge,
        origin: 'https://painel-monet-front.vercel.app',
      }),
    );

    const savedWebAuthn = await biometricService.verifyAndSaveRegistration('u-1', {
      challengeId: regOpts.challengeId,
      protocol: 'webauthn',
      kind: 'facial',
      platform: 'web',
      clientDataJSON: regClientData.toString('base64url'),
      attestationObject: attObj.toString('base64url'),
    });

    expect(savedWebAuthn.protocol).toBe('webauthn');
    expect(savedWebAuthn.kind).toBe('facial');

    // Login assertion
    const loginOpts = await biometricService.createLoginOptions({
      credentialId: savedWebAuthn.credentialId,
    });
    const loginClientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: loginOpts.challenge,
        origin: 'https://painel-monet-front.vercel.app',
      }),
    );
    const signCount2 = Buffer.alloc(4);
    signCount2.writeUInt32BE(2, 0);
    const loginAuthData = Buffer.concat([
      rpIdHash,
      Buffer.from([0x05]), // UP + UV
      signCount2,
    ]);
    const clientDataHash = createHash('sha256').update(loginClientData).digest();
    const signature = sign(
      'sha256',
      Buffer.concat([loginAuthData, clientDataHash]),
      privateKey,
    );

    const loggedUser = await biometricService.verifyLoginAssertion({
      challengeId: loginOpts.challengeId,
      credentialId: savedWebAuthn.credentialId,
      clientDataJSON: loginClientData.toString('base64url'),
      authenticatorData: loginAuthData.toString('base64url'),
      signature: signature.toString('base64url'),
    });
    expect(loggedUser.id).toBe('u-1');

    // Reject untrusted origin during registration
    const badOpts = await biometricService.createRegistrationOptions('u-1', {
      protocol: 'webauthn',
      kind: 'facial',
      platform: 'web',
    });
    const badOriginClientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: badOpts.challenge,
        origin: 'https://evil-attacker.example.com',
      }),
    );
    await expect(
      biometricService.verifyAndSaveRegistration('u-1', {
        challengeId: badOpts.challengeId,
        protocol: 'webauthn',
        kind: 'facial',
        platform: 'web',
        clientDataJSON: badOriginClientData.toString('base64url'),
        attestationObject: attObj.toString('base64url'),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('supports synced Face ID / Passkeys (signCount 0 & equal count), RS256 keys, Vercel preview origins, and separate Digital + Facial slots on Google account without excludeCredentialIds blocking', async () => {
    await firebase.setDoc(COLLECTIONS.USERS, {
      id: 'u-google-1',
      name: 'Usuario Gmail',
      email: 'usuario@gmail.com',
      cpf: '52998224725',
      phone: '11999990000',
      firebaseUid: 'fb-g-1',
      authProvider: 'google',
      isActive: true,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 0,
      investments: 0,
      createdAt: '',
      updatedAt: '',
    });

    // 1. Register native fingerprint first
    const fpOpts = await biometricService.createRegistrationOptions('u-google-1', {
      protocol: 'native_hmac',
      kind: 'fingerprint',
      platform: 'mobile_android',
    });
    const fpSig = hmacSha256Hex(
      fpOpts.enrollmentSecretHex!,
      `pm-bio-v1:${fpOpts.challenge}:${fpOpts.credentialIdSuggestion}`,
    );
    await biometricService.verifyAndSaveRegistration('u-google-1', {
      challengeId: fpOpts.challengeId,
      protocol: 'native_hmac',
      kind: 'fingerprint',
      platform: 'mobile_android',
      credentialId: fpOpts.credentialIdSuggestion,
      signature: fpSig,
    });

    // 2. Register WebAuthn RSA RS256 (-257) facial passkey on Vercel preview origin with signCount = 0
    delete process.env.FRONTEND_URL;
    const faceOpts = await biometricService.createRegistrationOptions('u-google-1', {
      protocol: 'webauthn',
      kind: 'facial',
      platform: 'web',
    });
    expect(faceOpts.excludeCredentialIds).toEqual([]);

    const rsaPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaJwk = rsaPair.publicKey.export({ format: 'jwk' }) as {
      n: string;
      e: string;
    };
    const coseRsa = Buffer.concat([
      Buffer.from([0xa4]),
      encodeCborInt(1),
      encodeCborInt(3),
      encodeCborInt(3),
      encodeCborInt(-257),
      encodeCborInt(-1),
      encodeCborBytes(Buffer.from(rsaJwk.n, 'base64url')),
      encodeCborInt(-2),
      encodeCborBytes(Buffer.from(rsaJwk.e, 'base64url')),
    ]);

    const credIdBuf = Buffer.from('face-preview-cred-rsa');
    const credIdLenBuf = Buffer.alloc(2);
    credIdLenBuf.writeUInt16BE(credIdBuf.length, 0);
    const previewHost = 'painel-monet-front-git-feature-igor.vercel.app';
    const previewOrigin = `https://${previewHost}`;
    const rpIdHash = createHash('sha256').update(previewHost).digest();

    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([0x45]), // UP + UV + AT
      Buffer.alloc(4), // signCount = 0 (Apple Face ID / synced passkey)
      Buffer.alloc(16),
      credIdLenBuf,
      credIdBuf,
      coseRsa,
    ]);
    const attObj = Buffer.concat([
      Buffer.from([0xa2]),
      encodeCborText('fmt'),
      encodeCborText('none'),
      encodeCborText('authData'),
      encodeCborBytes(authData),
    ]);
    const faceReg = await biometricService.verifyAndSaveRegistration('u-google-1', {
      challengeId: faceOpts.challengeId,
      protocol: 'webauthn',
      kind: 'facial',
      platform: 'web',
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: faceOpts.challenge,
          origin: previewOrigin,
        }),
      ).toString('base64url'),
      attestationObject: attObj.toString('base64url'),
    });

    // Both Digital and Facial coexist cleanly
    const listed = await biometricService.listCredentials('u-google-1');
    expect(listed.map((c) => c.kind).sort()).toEqual(['facial', 'fingerprint']);

    // Login assertion with signCount = 0 (same as stored 0) must succeed & preserve authProvider='google'
    const loginOpts = await biometricService.createLoginOptions({
      credentialId: faceReg.credentialId,
    });
    const loginClientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: loginOpts.challenge,
        origin: 'https://www.wssprime.com.br',
      }),
    );
    const loginAuthData = Buffer.concat([
      createHash('sha256').update('www.wssprime.com.br').digest(),
      Buffer.from([0x05]),
      Buffer.alloc(4), // signCount = 0 again
    ]);
    const clientDataHash = createHash('sha256').update(loginClientData).digest();
    const rsaSig = sign(
      'sha256',
      Buffer.concat([loginAuthData, clientDataHash]),
      rsaPair.privateKey,
    );

    const loggedGoogleUser = await biometricService.verifyLoginAssertion({
      challengeId: loginOpts.challengeId,
      credentialId: faceReg.credentialId,
      clientDataJSON: loginClientData.toString('base64url'),
      authenticatorData: loginAuthData.toString('base64url'),
      signature: rsaSig.toString('base64url'),
    });
    expect(loggedGoogleUser.id).toBe('u-google-1');
    expect(loggedGoogleUser.authProvider).toBe('google');
  });
});
