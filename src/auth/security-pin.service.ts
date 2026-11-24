import {
  BadRequestException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'crypto';
import { AuditService } from '../common/audit.service';
import { FirebaseService } from '../firebase/firebase.service';
import { COLLECTIONS, UserDoc } from '../firebase/firebase.types';
import { VerifySecurityPinDto } from './dto/security-pin.dto';

const PIN_FORMAT_RE = /^\d{4,6}$/;
const PIN_LOCKOUT_THRESHOLD = 5;
const PIN_LOCKOUT_DURATION_MS = 5 * 60 * 1000;
const PIN_DEVICE_TOKEN_SALT = Buffer.from('pm-pin-device-salt-v1', 'utf8');
const PIN_DEVICE_TOKEN_INFO = Buffer.from('pm-pin-device-hmac-v1', 'utf8');

@Injectable()
export class SecurityPinService {
  constructor(
    private readonly firebase: FirebaseService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private getDeviceTokenSigningKey(): Buffer {
    const rawSecret = (process.env.JWT_SECRET || '').trim();
    if (!rawSecret || rawSecret.length < 32 || rawSecret.includes('SUBSTITUA')) {
      throw new Error(
        '[SECURITY] JWT_SECRET ausente ou inválida para assinatura de token PIN.',
      );
    }
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(rawSecret, 'utf8'),
        PIN_DEVICE_TOKEN_SALT,
        PIN_DEVICE_TOKEN_INFO,
        32,
      ),
    );
  }

  private createPinHash(pin: string): string {
    if (!PIN_FORMAT_RE.test(pin)) {
      throw new BadRequestException(
        'O código de acesso deve conter entre 4 e 6 dígitos numéricos.',
      );
    }
    const salt = randomBytes(16).toString('hex');
    const derived = scryptSync(pin, salt, 64).toString('hex');
    return `scrypt_v1:${salt}:${derived}`;
  }

  private verifyPinHash(pin: string, storedHash: string): boolean {
    if (!PIN_FORMAT_RE.test(pin) || !storedHash) return false;
    const parts = storedHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt_v1') return false;
    const [, salt, expectedHex] = parts;
    if (!salt || !expectedHex) return false;
    try {
      const derived = scryptSync(pin, salt, 64);
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      if (derived.length !== expectedBuf.length) return false;
      return timingSafeEqual(derived, expectedBuf);
    } catch {
      return false;
    }
  }

  private issueDeviceToken(userId: string, pinVersion: number): string {
    const key = this.getDeviceTokenSigningKey();
    const payload = {
      u: userId,
      v: pinVersion,
      n: randomBytes(16).toString('base64url'),
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    const sigB64 = createHmac('sha256', key)
      .update(payloadB64)
      .digest('base64url');
    return `${payloadB64}.${sigB64}`;
  }

  private verifyDeviceToken(
    token: string,
  ): { userId: string; pinVersion: number } | null {
    const trimmed = (token || '').trim();
    const dotIdx = trimmed.indexOf('.');
    if (dotIdx <= 0 || dotIdx === trimmed.length - 1) return null;

    const payloadB64 = trimmed.slice(0, dotIdx);
    const sigB64 = trimmed.slice(dotIdx + 1);
    try {
      const key = this.getDeviceTokenSigningKey();
      const expectedSigB64 = createHmac('sha256', key)
        .update(payloadB64)
        .digest('base64url');
      const sigBuf = Buffer.from(sigB64, 'utf8');
      const expectedBuf = Buffer.from(expectedSigB64, 'utf8');
      if (
        sigBuf.length !== expectedBuf.length ||
        !timingSafeEqual(sigBuf, expectedBuf)
      ) {
        return null;
      }
      const parsed = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8'),
      ) as { u?: unknown; v?: unknown };
      if (
        typeof parsed.u !== 'string' ||
        !parsed.u ||
        typeof parsed.v !== 'number' ||
        !Number.isInteger(parsed.v)
      ) {
        return null;
      }
      return { userId: parsed.u, pinVersion: parsed.v };
    } catch {
      return null;
    }
  }

  async getStatus(userId: string) {
    const user = await this.firebase.findById<UserDoc>(COLLECTIONS.USERS, userId);
    if (!user || user.isActive === false) {
      throw new UnauthorizedException('Conta indisponível ou desativada.');
    }
    const lockedUntilMs =
      user.securityPinLockedUntilMs && Date.now() < user.securityPinLockedUntilMs
        ? user.securityPinLockedUntilMs
        : null;
    return {
      hasPin: Boolean(user.securityPinHash),
      updatedAt: user.securityPinUpdatedAt || null,
      lockedUntilMs,
      authProvider: user.authProvider || 'password',
    };
  }

  async setPin(userId: string, pin: string) {
    const user = await this.firebase.findById<UserDoc>(COLLECTIONS.USERS, userId);
    if (!user || user.isActive === false) {
      throw new UnauthorizedException('Conta indisponível ou desativada.');
    }

    const pinHash = this.createPinHash(pin);
    const nextVersion = Number(user.securityPinVersion || 0) + 1;
    const nowIso = new Date().toISOString();

    await this.firebase.updateDoc(COLLECTIONS.USERS, user.id, {
      securityPinHash: pinHash,
      securityPinVersion: nextVersion,
      securityPinUpdatedAt: nowIso,
      securityPinFailedAttempts: 0,
      securityPinLockedUntilMs: null,
      updatedAt: nowIso,
    });

    const pinDeviceToken = this.issueDeviceToken(user.id, nextVersion);

    void this.auditService?.log({
      actorUserId: user.id,
      action: 'auth.pin.set',
      resource: 'users',
      resourceId: user.id,
      outcome: 'ALLOW',
    });

    return {
      hasPin: true,
      updatedAt: nowIso,
      pinDeviceToken,
      authProvider: user.authProvider || 'password',
    };
  }

  async issueDeviceTokenForAuthenticatedUser(userId: string) {
    const user = await this.firebase.findById<UserDoc>(COLLECTIONS.USERS, userId);
    if (!user || user.isActive === false) {
      throw new UnauthorizedException('Conta indisponível ou desativada.');
    }
    if (!user.securityPinHash) {
      return {
        hasPin: false,
        updatedAt: null,
        pinDeviceToken: null,
        authProvider: user.authProvider || 'password',
      };
    }

    const version = Number(user.securityPinVersion || 1);
    if (!user.securityPinVersion) {
      await this.firebase.updateDoc(COLLECTIONS.USERS, user.id, {
        securityPinVersion: version,
      });
    }

    return {
      hasPin: true,
      updatedAt: user.securityPinUpdatedAt || null,
      pinDeviceToken: this.issueDeviceToken(user.id, version),
      authProvider: user.authProvider || 'password',
    };
  }

  async removePin(userId: string) {
    const user = await this.firebase.findById<UserDoc>(COLLECTIONS.USERS, userId);
    if (!user || user.isActive === false) {
      throw new UnauthorizedException('Conta indisponível ou desativada.');
    }

    const nextVersion = Number(user.securityPinVersion || 0) + 1;
    const nowIso = new Date().toISOString();

    await this.firebase.updateDoc(COLLECTIONS.USERS, user.id, {
      securityPinHash: null,
      securityPinVersion: nextVersion,
      securityPinUpdatedAt: null,
      securityPinFailedAttempts: 0,
      securityPinLockedUntilMs: null,
      updatedAt: nowIso,
    });

    void this.auditService?.log({
      actorUserId: user.id,
      action: 'auth.pin.remove',
      resource: 'users',
      resourceId: user.id,
      outcome: 'ALLOW',
    });

    return { hasPin: false };
  }

  async verifyPinForLogin(dto: VerifySecurityPinDto): Promise<UserDoc> {
    const parsedToken = this.verifyDeviceToken(dto.pinDeviceToken);
    if (!parsedToken) {
      throw new UnauthorizedException(
        'Dispositivo não autorizado para desbloqueio por código. Entre com sua senha ou Google.',
      );
    }

    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      parsedToken.userId,
    );
    if (!user || user.isActive === false || !user.securityPinHash) {
      throw new UnauthorizedException(
        'Código de acesso não configurado ou conta indisponível.',
      );
    }

    const currentVersion = Number(user.securityPinVersion || 1);
    if (parsedToken.pinVersion !== currentVersion) {
      throw new UnauthorizedException(
        'Código de acesso atualizado recentemente. Entre com sua senha ou Google para sincronizar.',
      );
    }

    const nowMs = Date.now();
    if (
      user.securityPinLockedUntilMs &&
      nowMs < user.securityPinLockedUntilMs
    ) {
      const waitMinutes = Math.max(
        1,
        Math.ceil((user.securityPinLockedUntilMs - nowMs) / 60000),
      );
      throw new UnauthorizedException(
        `Muitas tentativas incorretas. Aguarde ${waitMinutes} min ou entre com sua senha/Google.`,
      );
    }

    const isMatch = this.verifyPinHash(dto.pin, user.securityPinHash);
    if (!isMatch) {
      const failedAttempts = Number(user.securityPinFailedAttempts || 0) + 1;
      const shouldLock = failedAttempts >= PIN_LOCKOUT_THRESHOLD;
      const lockedUntilMs = shouldLock ? nowMs + PIN_LOCKOUT_DURATION_MS : null;

      await this.firebase.updateDoc(COLLECTIONS.USERS, user.id, {
        securityPinFailedAttempts: shouldLock ? 0 : failedAttempts,
        securityPinLockedUntilMs: lockedUntilMs,
      });

      void this.auditService?.log({
        actorUserId: user.id,
        action: 'auth.pin.verify',
        resource: 'auth',
        outcome: 'DENY',
        details: shouldLock ? 'locked_after_5_attempts' : 'wrong_pin',
      });

      throw new UnauthorizedException(
        shouldLock
          ? 'Código incorreto 5 vezes. Desbloqueio por código bloqueado por 5 minutos.'
          : 'Código de acesso incorreto.',
      );
    }

    await this.firebase.updateDoc(COLLECTIONS.USERS, user.id, {
      securityPinFailedAttempts: 0,
      securityPinLockedUntilMs: null,
    });

    void this.auditService?.log({
      actorUserId: user.id,
      action: 'auth.pin.verify',
      resource: 'auth',
      resourceId: user.id,
      outcome: 'ALLOW',
    });

    return user;
  }
}
