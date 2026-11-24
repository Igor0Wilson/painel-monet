import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, randomBytes, randomUUID as uuidv4, timingSafeEqual } from 'crypto';
import { AuditService } from '../common/audit.service';
import { FirebaseService } from '../firebase/firebase.service';
import {
  BiometricChallengeDoc,
  BiometricCredentialDoc,
  COLLECTIONS,
  UserDoc,
} from '../firebase/firebase.types';
import {
  BiometricLoginOptionsDto,
  BiometricLoginVerifyDto,
  BiometricRegisterOptionsDto,
  BiometricRegisterVerifyDto,
  UpdateBiometricCredentialDto,
} from './dto/biometric.dto';
import {
  verifyWebAuthnAssertionPayload,
  verifyWebAuthnRegistrationPayload,
} from './webauthn.utils';
import { getAllowedOrigins } from '../app.setup';

const CHALLENGE_TTL_MS = 3 * 60 * 1000;

@Injectable()
export class BiometricService {
  constructor(
    private readonly firebase: FirebaseService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private getAllowedWebAuthnOrigins(): string[] {
    const raw = [
      process.env.FRONTEND_URL,
      process.env.CORS_ORIGINS,
      process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : '',
      process.env.NODE_ENV !== 'production' ? 'http://127.0.0.1:3000' : '',
    ]
      .filter(Boolean)
      .join(',');

    const combined = [
      'https://painel-monet-front.vercel.app',
      'https://www.wssprime.com.br',
      'https://wssprime.com.br',
      ...getAllowedOrigins(),
      ...raw
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ];

    return Array.from(new Set(combined));
  }

  private computeNativeHmacSignature(
    secretHex: string,
    nonce: string,
    credentialId: string,
  ): string {
    return createHmac('sha256', Buffer.from(secretHex, 'hex'))
      .update(`pm-bio-v1:${nonce}:${credentialId}`)
      .digest('hex');
  }

  private toPublicCredentialView(doc: BiometricCredentialDoc) {
    return {
      id: doc.id,
      credentialId: doc.credentialId,
      protocol: doc.protocol,
      kind: doc.kind,
      platform: doc.platform,
      deviceLabel: doc.deviceLabel,
      isEnabled: Boolean(doc.isEnabled),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      lastUsedAt: doc.lastUsedAt || null,
    };
  }

  async listCredentials(userId: string) {
    const docs = await this.firebase.findByField<BiometricCredentialDoc>(
      COLLECTIONS.BIOMETRIC_CREDENTIALS,
      'userId',
      userId,
    );
    return docs
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((d) => this.toPublicCredentialView(d));
  }

  async createRegistrationOptions(
    userId: string,
    dto: BiometricRegisterOptionsDto,
  ) {
    const user = await this.firebase.findById<UserDoc>(COLLECTIONS.USERS, userId);
    if (!user || !user.isActive) {
      throw new ForbiddenException('Conta inativa ou não encontrada.');
    }

    const challengeId = uuidv4();
    const nonce = randomBytes(32).toString('base64url');
    const nowIso = new Date().toISOString();
    const credentialIdSuggestion =
      dto.protocol === 'native_hmac' ? uuidv4() : undefined;
    const enrollmentSecretHex =
      dto.protocol === 'native_hmac'
        ? randomBytes(32).toString('hex')
        : undefined;

    const challengeDoc: BiometricChallengeDoc = {
      id: challengeId,
      nonce,
      purpose: 'register',
      userId,
      credentialId: credentialIdSuggestion || null,
      pendingSecretHex: enrollmentSecretHex || null,
      protocol: dto.protocol,
      kind: dto.kind,
      createdAt: nowIso,
      expiresAtMs: Date.now() + CHALLENGE_TTL_MS,
      consumed: false,
    };

    await this.firebase.setDoc(COLLECTIONS.BIOMETRIC_CHALLENGES, challengeDoc);

    return {
      challengeId,
      challenge: nonce,
      userId: user.id,
      userName: user.name,
      credentialIdSuggestion,
      enrollmentSecretHex,
      // Omit excludeCredentialIds so users can enroll separate Facial & Digital methods
      // or reconfigure an existing synced Passkey / Face ID without InvalidStateError.
      excludeCredentialIds: [],
    };
  }

  async verifyAndSaveRegistration(
    userId: string,
    dto: BiometricRegisterVerifyDto,
  ) {
    const challengeDoc = await this.firebase.findById<BiometricChallengeDoc>(
      COLLECTIONS.BIOMETRIC_CHALLENGES,
      dto.challengeId,
    );

    if (
      !challengeDoc ||
      challengeDoc.consumed ||
      challengeDoc.purpose !== 'register' ||
      challengeDoc.userId !== userId ||
      Date.now() > challengeDoc.expiresAtMs
    ) {
      throw new BadRequestException(
        'Desafio biométrico inválido ou expirado. Tente ativar novamente.',
      );
    }

    await this.firebase.updateDoc(
      COLLECTIONS.BIOMETRIC_CHALLENGES,
      challengeDoc.id,
      { consumed: true },
    );

    let finalCredentialId = '';
    let publicKeySpkiPem: string | null = null;
    let nativeSecretHex: string | null = null;
    let signCount = 0;

    if (dto.protocol === 'webauthn') {
      if (!dto.clientDataJSON || !dto.attestationObject) {
        throw new BadRequestException(
          'Dados WebAuthn incompletos para registrar biometria/facial.',
        );
      }

      try {
        const verified = verifyWebAuthnRegistrationPayload({
          clientDataJSONB64: dto.clientDataJSON,
          attestationObjectB64: dto.attestationObject,
          expectedChallenge: challengeDoc.nonce,
          allowedOrigins: this.getAllowedWebAuthnOrigins(),
        });
        finalCredentialId = verified.credentialIdB64;
        publicKeySpkiPem = verified.publicKeySpkiPem;
        signCount = verified.signCount;
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error
            ? err.message
            : 'Falha ao validar registro biométrico WebAuthn.',
        );
      }
    } else {
      finalCredentialId =
        dto.credentialId?.trim() || challengeDoc.credentialId || '';
      const resolvedSecretHex =
        challengeDoc.pendingSecretHex || dto.nativeSecretHex || '';
      if (!finalCredentialId || !resolvedSecretHex || !dto.signature) {
        throw new BadRequestException(
          'Dados de registro biométrico do aplicativo incompletos.',
        );
      }

      const expectedSig = this.computeNativeHmacSignature(
        resolvedSecretHex,
        challengeDoc.nonce,
        finalCredentialId,
      );
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      const providedBuf = Buffer.from(dto.signature, 'hex');
      if (
        expectedBuf.length !== providedBuf.length ||
        !timingSafeEqual(expectedBuf, providedBuf)
      ) {
        throw new BadRequestException(
          'Assinatura de registro biométrico do aplicativo inválida.',
        );
      }
      nativeSecretHex = resolvedSecretHex.toLowerCase();
    }

    const duplicate = await this.firebase.findOneByField<BiometricCredentialDoc>(
      COLLECTIONS.BIOMETRIC_CREDENTIALS,
      'credentialId',
      finalCredentialId,
    );
    if (duplicate && duplicate.userId !== userId) {
      throw new BadRequestException(
        'Esta credencial biométrica já está vinculada a outra conta.',
      );
    }

    const nowIso = new Date().toISOString();
    const defaultLabel =
      dto.platform === 'web'
        ? 'Navegador Web (Reconhecimento Facial)'
        : dto.platform === 'pwa'
          ? 'App Instalado PWA (Digital / Facial)'
          : 'Aplicativo Mobile (Digital / Facial)';

    const credDoc: BiometricCredentialDoc = {
      id: duplicate?.id || uuidv4(),
      userId,
      credentialId: finalCredentialId,
      protocol: dto.protocol,
      kind: dto.kind,
      platform: dto.platform,
      deviceLabel: (dto.deviceLabel || defaultLabel).trim().slice(0, 80),
      publicKeySpkiPem,
      nativeSecretHex,
      signCount,
      isEnabled: true,
      createdAt: duplicate?.createdAt || nowIso,
      updatedAt: nowIso,
      lastUsedAt: null,
    };

    await this.firebase.setDoc(COLLECTIONS.BIOMETRIC_CREDENTIALS, credDoc);

    void this.auditService?.log({
      actorUserId: userId,
      action: 'auth.biometric.register',
      resource: 'biometric_credentials',
      resourceId: credDoc.id,
      outcome: 'ALLOW',
      details: `protocol=${dto.protocol},kind=${dto.kind},platform=${dto.platform}`,
    });

    return this.toPublicCredentialView(credDoc);
  }

  async updateCredential(
    userId: string,
    id: string,
    dto: UpdateBiometricCredentialDto,
  ) {
    const existing = await this.firebase.findById<BiometricCredentialDoc>(
      COLLECTIONS.BIOMETRIC_CREDENTIALS,
      id,
    );
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Credencial biométrica não encontrada.');
    }

    const nowIso = new Date().toISOString();
    const updateData: Partial<BiometricCredentialDoc> = {
      updatedAt: nowIso,
    };
    if (dto.isEnabled !== undefined) {
      updateData.isEnabled = Boolean(dto.isEnabled);
    }
    if (dto.kind !== undefined) {
      updateData.kind = dto.kind;
    }
    if (dto.deviceLabel !== undefined && dto.deviceLabel.trim()) {
      updateData.deviceLabel = dto.deviceLabel.trim().slice(0, 80);
    }

    await this.firebase.updateDoc(
      COLLECTIONS.BIOMETRIC_CREDENTIALS,
      id,
      updateData as Record<string, unknown>,
    );

    return this.toPublicCredentialView({
      ...existing,
      ...updateData,
    });
  }

  async deleteCredential(userId: string, id: string): Promise<{ deleted: true }> {
    const existing = await this.firebase.findById<BiometricCredentialDoc>(
      COLLECTIONS.BIOMETRIC_CREDENTIALS,
      id,
    );
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Credencial biométrica não encontrada.');
    }

    await this.firebase.deleteDoc(COLLECTIONS.BIOMETRIC_CREDENTIALS, id);

    void this.auditService?.log({
      actorUserId: userId,
      action: 'auth.biometric.delete',
      resource: 'biometric_credentials',
      resourceId: id,
      outcome: 'ALLOW',
    });

    return { deleted: true };
  }

  async createLoginOptions(dto: BiometricLoginOptionsDto) {
    const cred = await this.firebase.findOneByField<BiometricCredentialDoc>(
      COLLECTIONS.BIOMETRIC_CREDENTIALS,
      'credentialId',
      dto.credentialId.trim(),
    );

    if (!cred || !cred.isEnabled) {
      throw new UnauthorizedException(
        'Biometria não configurada ou desativada neste dispositivo.',
      );
    }

    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      cred.userId,
    );
    if (!user || user.isActive === false) {
      throw new UnauthorizedException(
        'Conta inativa ou indisponível para autenticação biométrica.',
      );
    }

    const challengeId = uuidv4();
    const nonce = randomBytes(32).toString('base64url');
    const challengeDoc: BiometricChallengeDoc = {
      id: challengeId,
      nonce,
      purpose: 'login',
      userId: cred.userId,
      credentialId: cred.credentialId,
      protocol: cred.protocol,
      kind: cred.kind,
      createdAt: new Date().toISOString(),
      expiresAtMs: Date.now() + CHALLENGE_TTL_MS,
      consumed: false,
    };

    await this.firebase.setDoc(COLLECTIONS.BIOMETRIC_CHALLENGES, challengeDoc);

    return {
      challengeId,
      challenge: nonce,
      credentialId: cred.credentialId,
      protocol: cred.protocol,
      kind: cred.kind,
    };
  }

  async verifyLoginAssertion(dto: BiometricLoginVerifyDto): Promise<UserDoc> {
    const challengeDoc = await this.firebase.findById<BiometricChallengeDoc>(
      COLLECTIONS.BIOMETRIC_CHALLENGES,
      dto.challengeId,
    );

    if (
      !challengeDoc ||
      challengeDoc.consumed ||
      challengeDoc.purpose !== 'login' ||
      challengeDoc.credentialId !== dto.credentialId.trim() ||
      Date.now() > challengeDoc.expiresAtMs
    ) {
      throw new UnauthorizedException(
        'Desafio biométrico expirado ou inválido.',
      );
    }

    await this.firebase.updateDoc(
      COLLECTIONS.BIOMETRIC_CHALLENGES,
      challengeDoc.id,
      { consumed: true },
    );

    const cred = await this.firebase.findOneByField<BiometricCredentialDoc>(
      COLLECTIONS.BIOMETRIC_CREDENTIALS,
      'credentialId',
      dto.credentialId.trim(),
    );

    if (!cred || !cred.isEnabled) {
      throw new UnauthorizedException('Credencial biométrica desativada.');
    }

    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      cred.userId,
    );
    if (!user || user.isActive === false) {
      throw new UnauthorizedException('Conta indisponível ou desativada.');
    }

    let nextSignCount = cred.signCount;

    if (cred.protocol === 'webauthn') {
      if (
        !dto.clientDataJSON ||
        !dto.authenticatorData ||
        !dto.signature ||
        !cred.publicKeySpkiPem
      ) {
        throw new UnauthorizedException(
          'Assinatura WebAuthn ausente ou incompleta.',
        );
      }
      try {
        const res = verifyWebAuthnAssertionPayload({
          clientDataJSONB64: dto.clientDataJSON,
          authenticatorDataB64: dto.authenticatorData,
          signatureB64: dto.signature,
          expectedChallenge: challengeDoc.nonce,
          allowedOrigins: this.getAllowedWebAuthnOrigins(),
          publicKeySpkiPem: cred.publicKeySpkiPem,
          storedSignCount: Number(cred.signCount || 0),
        });
        nextSignCount = res.newSignCount;
      } catch (err) {
        void this.auditService?.log({
          actorUserId: cred.userId,
          action: 'auth.biometric.login',
          resource: 'auth',
          outcome: 'DENY',
          details: err instanceof Error ? err.message : 'webauthn_failed',
        });
        throw new UnauthorizedException(
          err instanceof Error
            ? err.message
            : 'Falha na autenticação biométrica.',
        );
      }
    } else {
      if (!cred.nativeSecretHex || !dto.signature) {
        throw new UnauthorizedException('Assinatura biométrica inválida.');
      }
      const expected = this.computeNativeHmacSignature(
        cred.nativeSecretHex,
        challengeDoc.nonce,
        cred.credentialId,
      );
      const expectedBuf = Buffer.from(expected, 'hex');
      const providedBuf = Buffer.from(dto.signature, 'hex');
      if (
        expectedBuf.length !== providedBuf.length ||
        !timingSafeEqual(expectedBuf, providedBuf)
      ) {
        void this.auditService?.log({
          actorUserId: cred.userId,
          action: 'auth.biometric.login',
          resource: 'auth',
          outcome: 'DENY',
          details: 'native_hmac_mismatch',
        });
        throw new UnauthorizedException('Assinatura biométrica inválida.');
      }
    }

    const nowIso = new Date().toISOString();
    await this.firebase.updateDoc(COLLECTIONS.BIOMETRIC_CREDENTIALS, cred.id, {
      signCount: nextSignCount,
      lastUsedAt: nowIso,
      updatedAt: nowIso,
    });

    void this.auditService?.log({
      actorUserId: user.id,
      action: 'auth.biometric.login',
      resource: 'auth',
      resourceId: cred.id,
      outcome: 'ALLOW',
      details: `protocol=${cred.protocol},kind=${cred.kind}`,
    });

    return user;
  }
}
