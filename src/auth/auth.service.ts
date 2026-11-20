import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { normalizeCpf } from '../common/cpf.utils';
import { FirebaseService } from '../firebase/firebase.service';
import { UserDoc } from '../firebase/firebase.types';
import { UsersService } from '../users/users.service';
import { FirebaseRegisterDto } from './dto/firebase-register.dto';
import { GoogleCompleteDto } from './dto/google-complete.dto';

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
  ) {}

  private buildAuthResponse(user: UserDoc) {
    const payload = { userId: user.id, email: user.email };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        cpf: user.cpf,
        phone: user.phone,
      },
    };
  }

  private maskEmail(email: string): string {
    const [localPart, domain] = email.split('@');
    if (!localPart || !domain) return '***';
    const visible = localPart.slice(0, Math.min(2, localPart.length));
    return `${visible}***@${domain}`;
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

  private getFrontendContinueUrl(mode: 'reset' | 'reactivate'): string | undefined {
    const firstOrigin = (process.env.FRONTEND_URL || '')
      .split(',')
      .map((item) => item.trim().replace(/\/+$/, ''))
      .find(Boolean);
    if (!firstOrigin) return undefined;
    return mode === 'reactivate'
      ? `${firstOrigin}/login?reactivated=1`
      : `${firstOrigin}/login?passwordReset=1`;
  }

  async loginWithFirebase(idToken: string) {
    let decoded;
    try {
      decoded = await this.firebase.verifyFirebaseIdToken(idToken);
    } catch (error) {
      this.logger.warn(
        `Falha ao validar token Firebase: ${error instanceof Error ? error.message : String(error)}`,
      );
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

      throw new UnauthorizedException(
        'Conta não encontrada no banco de dados do Painel Monet. Realize seu cadastro primeiro.',
      );
    }

    let reactivated = false;
    if (existing.isActive === false) {
      const fbAccount = await this.firebase.lookupFirebaseUser({
        uid: decoded.uid,
      });
      const passwordUpdatedAt = Number(fbAccount?.passwordUpdatedAt || 0);
      const requiredAfterMs = Number(existing.deactivatedAtMs || 0);

      if (passwordUpdatedAt > requiredAfterMs && requiredAfterMs > 0) {
        await this.usersService.reactivateUser(existing.id);
        reactivated = true;
      } else {
        throw new ForbiddenException({
          message:
            'Sua conta está desativada. Solicite o e-mail de reativação para definir uma nova senha e reativar seu acesso.',
          code: 'ACCOUNT_DEACTIVATED',
        });
      }
    }

    if (!existing.firebaseUid) {
      await this.usersService.linkFirebaseUid(existing.id, decoded.uid);
    }

    const profileIncomplete =
      !existing.name?.trim() || !existing.cpf || !existing.phone;
    if (isGoogle && profileIncomplete) {
      const completionToken = this.jwtService.sign(
        {
          purpose: 'google_profile_completion',
          email,
          firebaseUid: decoded.uid,
          name: existing.name || decoded.name || '',
        },
        { expiresIn: '15m' },
      );

      return {
        requiresProfileCompletion: true,
        completionToken,
        googleProfile: {
          email,
          name: existing.name || decoded.name || '',
          cpf: existing.cpf || '',
          phone: existing.phone || '',
        },
      };
    }

    return {
      requiresProfileCompletion: false,
      reactivated,
      ...this.buildAuthResponse(existing),
    };
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

    await this.firebase.sendFirebasePasswordResetEmail(user.email, continueUrl);

    return {
      message:
        effectiveMode === 'reactivate'
          ? 'Enviamos um e-mail oficial do Firebase com o botão/link para definir sua nova senha e reativar sua conta.'
          : 'Enviamos um e-mail oficial do Firebase com o link para redefinir sua senha.',
      maskedEmail: this.maskEmail(user.email),
      isDeactivated: user.isActive === false,
    };
  }
}
