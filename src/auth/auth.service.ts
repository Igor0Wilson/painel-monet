import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../common/audit.service';
import { buildProtectedMediaPath } from '../common/cloudinary.service';
import { maskCpf, maskEmail, maskPhone, normalizeCpf } from '../common/cpf.utils';
import { redactSensitiveText } from '../common/data-crypto.utils';
import { FirebaseService } from '../firebase/firebase.service';
import { UserDoc } from '../firebase/firebase.types';
import { UsersService } from '../users/users.service';
import { FirebaseRegisterDto } from './dto/firebase-register.dto';
import { GoogleCompleteDto } from './dto/google-complete.dto';
import { EmailSenderService } from './email-sender.service';
import {
  buildPasswordResetEmailHtml,
  buildPasswordResetEmailSubject,
  buildPasswordResetEmailText,
} from './email-template';

interface GoogleCompletionPayload {
  purpose: string;
  email: string;
  firebaseUid: string;
  name?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly firebase: FirebaseService,
    private readonly emailSender: EmailSenderService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private buildAuthResponse(user: UserDoc) {
    return this.issueJwtSession(user);
  }

  issueJwtSession(user: UserDoc) {
    const payload = {
      userId: user.id,
      tv: user.tokenVersion ?? 1,
    };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        name: user.name,
        maskedEmail: maskEmail(user.email),
        maskedCpf: user.cpf ? maskCpf(user.cpf) : null,
        maskedPhone: maskPhone(user.phone),
        hasCpf: Boolean(user.cpf),
        avatarUrl: buildProtectedMediaPath(
          'avatar',
          user.id,
          user.avatarUrl,
          user.avatarPublicId,
        ),
      },
    };
  }

  private async findUserByIdentifier(identifier: string): Promise<UserDoc | null> {
    const trimmed = identifier.trim();
    if (!trimmed) return null;
    if (trimmed.includes('@')) {
      return this.usersService.findByEmail(trimmed);
    }
    const cpf = normalizeCpf(trimmed);
    if (cpf.length === 11) {
      return this.usersService.findByCpf(cpf);
    }
    return null;
  }

  private getFrontendOrigin(): string | undefined {
    return (process.env.FRONTEND_URL || '')
      .split(',')
      .map((item) => item.trim().replace(/\/+$/, ''))
      .find(Boolean);
  }

  private getFrontendContinueUrl(mode: 'reset' | 'reactivate'): string | undefined {
    const firstOrigin = this.getFrontendOrigin();
    if (!firstOrigin) return undefined;
    return mode === 'reactivate'
      ? `${firstOrigin}/login?reactivated=1`
      : `${firstOrigin}/login?passwordReset=1`;
  }

  private buildBrandedActionUrl(
    firebaseOobLink: string,
    mode: 'reset' | 'reactivate',
  ): string {
    const origin = this.getFrontendOrigin();
    if (!origin) return firebaseOobLink;
    try {
      const parsed = new URL(firebaseOobLink);
      const oobCode = parsed.searchParams.get('oobCode');
      if (!oobCode) return firebaseOobLink;
      return `${origin}/auth/action?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}&intent=${mode}`;
    } catch {
      return firebaseOobLink;
    }
  }

  async loginWithFirebase(idToken: string) {
    let decoded;
    try {
      decoded = await this.firebase.verifyFirebaseIdToken(idToken);
    } catch (error) {
      this.logger.warn(
        `Falha ao validar token Firebase: ${error instanceof Error ? redactSensitiveText(error.message) : 'token inválido'}`,
      );
      void this.auditService?.log({
        actorUserId: 'anonymous',
        action: 'auth.login.failure',
        resource: 'auth',
        outcome: 'DENY',
        details: 'invalid_firebase_token',
      });
      throw new UnauthorizedException(
        'Sessão do Firebase inválida ou expirada. Faça login novamente.',
      );
    }

    const email = decoded.email?.trim().toLowerCase();
    if (!email) {
      throw new UnauthorizedException(
        'A conta selecionada não possui um e-mail válido.',
      );
    }

    const isGoogle = decoded.signInProvider === 'google.com';
    if (isGoogle && !decoded.email_verified) {
      throw new UnauthorizedException(
        'A conta Google precisa possuir um e-mail verificado.',
      );
    }

    const existing =
      (await this.usersService.findByFirebaseUid(decoded.uid)) ||
      (await this.usersService.findByEmail(email));

    if (!existing) {
      if (isGoogle) {
        const completionToken = this.jwtService.sign(
          {
            purpose: 'google_profile_completion',
            email,
            firebaseUid: decoded.uid,
            name: decoded.name || '',
          },
          { expiresIn: '15m' },
        );

        return {
          requiresProfileCompletion: true,
          completionToken,
          googleProfile: {
            email,
            name: decoded.name || '',
            cpf: '',
            phone: '',
          },
        };
      }

      void this.auditService?.log({
        actorUserId: 'anonymous',
        action: 'auth.login.failure',
        resource: 'auth',
        outcome: 'DENY',
        details: 'account_not_found',
      });
      throw new UnauthorizedException(
        'Conta não encontrada no banco de dados do Painel Monet. Realize seu cadastro primeiro.',
      );
    }

    let reactivated = false;
    let effectiveUser = existing;
    if (existing.isActive === false) {
      const fbAccount = await this.firebase.lookupFirebaseUser({
        uid: decoded.uid,
      });
      const passwordUpdatedAt = Number(fbAccount?.passwordUpdatedAt || 0);
      const requiredAfterMs = Number(existing.deactivatedAtMs || 0);

      if (passwordUpdatedAt > requiredAfterMs && requiredAfterMs > 0) {
        await this.usersService.reactivateUser(existing.id);
        reactivated = true;
        effectiveUser = (await this.usersService.findById(existing.id)) || existing;
      } else {
        void this.auditService?.log({
          actorUserId: existing.id,
          action: 'auth.login.failure',
          resource: 'auth',
          outcome: 'DENY',
          details: 'account_deactivated',
        });
        throw new ForbiddenException({
          message:
            'Sua conta está desativada. Solicite o e-mail de reativação para definir uma nova senha e reativar seu acesso.',
          code: 'ACCOUNT_DEACTIVATED',
        });
      }
    }

    if (!effectiveUser.firebaseUid) {
      await this.usersService.linkFirebaseUid(effectiveUser.id, decoded.uid);
    }

    const profileIncomplete =
      !effectiveUser.name?.trim() || !effectiveUser.cpf || !effectiveUser.phone;
    if (isGoogle && profileIncomplete) {
      const completionToken = this.jwtService.sign(
        {
          purpose: 'google_profile_completion',
          email,
          firebaseUid: decoded.uid,
          name: effectiveUser.name || decoded.name || '',
        },
        { expiresIn: '15m' },
      );

      return {
        requiresProfileCompletion: true,
        completionToken,
        googleProfile: {
          email,
          name: effectiveUser.name || decoded.name || '',
          cpf: '',
          phone: '',
        },
      };
    }

    void this.auditService?.log({
      actorUserId: effectiveUser.id,
      action: reactivated ? 'auth.account.reactivated' : 'auth.login.success',
      resource: 'auth',
      resourceId: effectiveUser.id,
      outcome: 'ALLOW',
    });

    return {
      requiresProfileCompletion: false,
      reactivated,
      ...this.buildAuthResponse(effectiveUser),
    };
  }

  async logout(userId: string): Promise<{ message: string }> {
    await this.usersService.revokeUserTokens(userId);
    void this.auditService?.log({
      actorUserId: userId,
      action: 'auth.logout',
      resource: 'auth',
      resourceId: userId,
      outcome: 'ALLOW',
    });
    return { message: 'Sessão encerrada com segurança.' };
  }

  async registerWithFirebase(dto: FirebaseRegisterDto) {
    let decoded;
    try {
      decoded = await this.firebase.verifyFirebaseIdToken(dto.idToken);
    } catch {
      throw new UnauthorizedException(
        'Sessão de cadastro Firebase inválida ou expirada.',
      );
    }

    const email = decoded.email?.trim().toLowerCase();
    if (!email) {
      throw new UnauthorizedException('E-mail ausente no token Firebase.');
    }

    const isPasswordProvider = decoded.signInProvider !== 'google.com';

    try {
      const user = await this.usersService.createFromFirebase({
        email,
        firebaseUid: decoded.uid,
        authProvider: isPasswordProvider ? 'password' : 'google',
        name: dto.name,
        cpf: dto.cpf,
        phone: dto.phone,
      });

      return this.buildAuthResponse(user);
    } catch (error) {
      if (isPasswordProvider) {
        const existingInDb = await this.usersService.findByFirebaseUid(
          decoded.uid,
        );
        if (!existingInDb) {
          await this.firebase
            .deleteFirebaseUser(decoded.uid)
            .catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async completeGoogleProfile(dto: GoogleCompleteDto) {
    let payload: GoogleCompletionPayload;
    try {
      payload = this.jwtService.verify<GoogleCompletionPayload>(
        dto.completionToken,
        { algorithms: ['HS256'] },
      );
    } catch {
      throw new UnauthorizedException(
        'Sessão de cadastro Google expirada. Faça login com o Google novamente.',
      );
    }

    if (
      payload.purpose !== 'google_profile_completion' ||
      !payload.email ||
      !payload.firebaseUid
    ) {
      throw new UnauthorizedException('Token de cadastro Google inválido.');
    }

    const user = await this.usersService.createFromFirebase({
      email: payload.email,
      firebaseUid: payload.firebaseUid,
      authProvider: 'google',
      name: dto.name,
      cpf: dto.cpf,
      phone: dto.phone,
    });

    return this.buildAuthResponse(user);
  }

  async requestPasswordResetOrReactivation(
    identifier: string,
    mode: 'reset' | 'reactivate' = 'reset',
  ) {
    const user = await this.findUserByIdentifier(identifier);
    if (!user) {
      return {
        message:
          'Se encontrarmos uma conta com esses dados, enviamos o e-mail oficial do Firebase para redefinir sua senha.',
        maskedEmail: null,
        isDeactivated: false,
      };
    }

    const effectiveMode: 'reset' | 'reactivate' =
      user.isActive === false ? 'reactivate' : mode;
    const continueUrl = this.getFrontendContinueUrl(effectiveMode);

    let sentCustomHtml = false;
    if (this.emailSender.hasCustomProvider()) {
      try {
        const firebaseOobLink =
          await this.firebase.generateFirebasePasswordResetLink(
            user.email,
            continueUrl,
          );
        const actionUrl = this.buildBrandedActionUrl(
          firebaseOobLink,
          effectiveMode,
        );
        const origin = this.getFrontendOrigin();
        const logoUrl = origin ? `${origin}/logo192.png?v=5` : undefined;

        const html = buildPasswordResetEmailHtml({
          userName: user.name,
          actionUrl,
          mode: effectiveMode,
          logoUrl,
        });
        const text = buildPasswordResetEmailText({
          userName: user.name,
          actionUrl,
          mode: effectiveMode,
          logoUrl,
        });
        const subject = buildPasswordResetEmailSubject(effectiveMode);

        const result = await this.emailSender.sendHtmlEmail({
          toEmail: user.email,
          toName: user.name,
          subject,
          html,
          text,
        });
        sentCustomHtml = result.sent;
      } catch (error) {
        this.logger.warn(
          `Fallback para e-mail nativo do Firebase: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!sentCustomHtml) {
      await this.firebase.sendFirebasePasswordResetEmail(
        user.email,
        continueUrl,
      );
    }

    return {
      message:
        effectiveMode === 'reactivate'
          ? 'Enviamos um e-mail com o botão para definir sua nova senha e reativar sua conta.'
          : 'Enviamos um e-mail com o botão/link para redefinir sua senha.',
      maskedEmail: maskEmail(user.email),
      isDeactivated: user.isActive === false,
      customTemplate: sentCustomHtml,
    };
  }
}
