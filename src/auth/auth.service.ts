import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import {
  createHash,
  randomInt,
  randomUUID as uuidv4,
  timingSafeEqual,
} from 'crypto';
import { normalizeCpf } from '../common/cpf.utils';
import { FirebaseService } from '../firebase/firebase.service';
import {
  COLLECTIONS,
  PasswordResetDoc,
  UserDoc,
} from '../firebase/firebase.types';
import { UsersService } from '../users/users.service';
import { GoogleCompleteDto } from './dto/google-complete.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

interface GoogleCompletionPayload {
  purpose: string;
  email: string;
  googleUid: string;
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

  private hashCode(code: string): string {
    return createHash('sha256').update(code.trim()).digest('hex');
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

  private async sendRecoveryEmail(
    toEmail: string,
    userName: string,
    code: string,
  ): Promise<boolean> {
    const resendApiKey = process.env.RESEND_API_KEY?.trim();
    const mailFrom =
      process.env.MAIL_FROM?.trim() || 'Painel Monet <onboarding@resend.dev>';

    if (!resendApiKey) {
      this.logger.warn(
        'RESEND_API_KEY não configurada — e-mail de recuperação não enviado externamente.',
      );
      return false;
    }

    const safeName = userName.replace(/[<>&"']/g, '');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailFrom,
        to: [toEmail],
        subject: 'Código de recuperação de senha — Painel Monet',
        html: `<p>Olá, ${safeName}.</p><p>Seu código de recuperação de senha é: <strong>${code}</strong></p><p>Este código expira em 15 minutos. Se você não solicitou, ignore este e-mail.</p>`,
      }),
    });

    if (!response.ok) {
      this.logger.error(
        `Falha ao enviar e-mail de recuperação via Resend (HTTP ${response.status})`,
      );
      return false;
    }

    return true;
  }

  async login(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const senhaValida = await bcrypt.compare(password, user.password);
    if (!senhaValida) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    return this.buildAuthResponse(user);
  }

  async loginWithGoogle(idToken: string) {
    let decoded;
    try {
      decoded = await this.firebase.verifyGoogleIdToken(idToken);
    } catch (error) {
      this.logger.warn(
        `Falha ao validar token Google: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('Token do Google inválido ou expirado.');
    }

    const email = decoded.email?.trim().toLowerCase();
    if (!email || !decoded.email_verified) {
      throw new UnauthorizedException(
        'A conta Google precisa possuir um e-mail verificado.',
      );
    }

    const existing = await this.usersService.findByEmail(email);
    if (existing && existing.name?.trim() && existing.cpf && existing.phone) {
      if (!existing.googleUid) {
        await this.usersService.linkGoogleUid(existing.id, decoded.uid);
      }
      return {
        requiresProfileCompletion: false,
        ...this.buildAuthResponse(existing),
      };
    }

    const completionToken = this.jwtService.sign(
      {
        purpose: 'google_profile_completion',
        email,
        googleUid: decoded.uid,
        name: existing?.name || decoded.name || '',
      },
      { expiresIn: '15m' },
    );

    return {
      requiresProfileCompletion: true,
      completionToken,
      googleProfile: {
        email,
        name: existing?.name || decoded.name || '',
        cpf: existing?.cpf || '',
        phone: existing?.phone || '',
      },
    };
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
      !payload.googleUid
    ) {
      throw new UnauthorizedException('Token de cadastro Google inválido.');
    }

    const user = await this.usersService.createOrCompleteGoogleUser({
      email: payload.email,
      googleUid: payload.googleUid,
      name: dto.name,
      cpf: dto.cpf,
      phone: dto.phone,
    });

    return this.buildAuthResponse(user);
  }

  async requestPasswordReset(identifier: string) {
    const user = await this.findUserByIdentifier(identifier);
    if (!user) {
      return {
        message:
          'Se encontrarmos uma conta com esses dados, enviaremos um código de 6 dígitos para o e-mail cadastrado.',
        maskedEmail: null,
      };
    }

    const code = String(randomInt(100000, 1000000));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

    const resetDoc: PasswordResetDoc = {
      id: uuidv4(),
      userId: user.id,
      email: user.email,
      codeHash: this.hashCode(code),
      attempts: 0,
      used: false,
      expiresAt,
      createdAt: now.toISOString(),
    };

    await this.firebase.setDoc(COLLECTIONS.PASSWORD_RESETS, resetDoc);

    const emailSent = await this.sendRecoveryEmail(user.email, user.name, code);
    const isLocalDev =
      !process.env.VERCEL && process.env.NODE_ENV !== 'production';

    return {
      message: emailSent
        ? 'Enviamos um código de 6 dígitos para o e-mail vinculado à sua conta.'
        : 'Código de recuperação gerado. Configure RESEND_API_KEY para envio automático por e-mail.',
      maskedEmail: this.maskEmail(user.email),
      ...(isLocalDev && !emailSent ? { devCode: code } : {}),
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.findUserByIdentifier(dto.identifier);
    if (!user) {
      throw new BadRequestException(
        'Código de recuperação inválido ou expirado.',
      );
    }

    const resets = await this.firebase.findByField<PasswordResetDoc>(
      COLLECTIONS.PASSWORD_RESETS,
      'userId',
      user.id,
    );

    const activeReset = resets
      .filter((r) => !r.used && new Date(r.expiresAt).getTime() > Date.now())
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];

    if (!activeReset) {
      throw new BadRequestException(
        'Código de recuperação inválido ou expirado.',
      );
    }

    if (activeReset.attempts >= 5) {
      await this.firebase.updateDoc(
        COLLECTIONS.PASSWORD_RESETS,
        activeReset.id,
        { used: true },
      );
      throw new BadRequestException(
        'Muitas tentativas incorretas. Solicite um novo código.',
      );
    }

    const providedHash = Buffer.from(this.hashCode(dto.code), 'hex');
    const storedHash = Buffer.from(activeReset.codeHash, 'hex');
    const validCode =
      providedHash.length === storedHash.length &&
      timingSafeEqual(providedHash, storedHash);

    if (!validCode) {
      await this.firebase.updateDoc(
        COLLECTIONS.PASSWORD_RESETS,
        activeReset.id,
        { attempts: activeReset.attempts + 1 },
      );
      throw new BadRequestException(
        'Código de recuperação inválido ou expirado.',
      );
    }

    await this.firebase.updateDoc(
      COLLECTIONS.PASSWORD_RESETS,
      activeReset.id,
      { used: true },
    );
    await this.usersService.updatePassword(user.id, dto.newPassword);

    return {
      message: 'Senha redefinida com sucesso! Faça login com sua nova senha.',
    };
  }
}
