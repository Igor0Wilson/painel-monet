import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly usersService: UsersService) {
    const secret = process.env.JWT_SECRET?.trim() || '';
    if (!secret || secret.length < 32 || secret.includes('SUBSTITUA')) {
      throw new Error(
        '[SECURITY] JWT_SECRET ausente, fraca ou padrão nas variáveis de ambiente.',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      algorithms: ['HS256'],
    });
  }

  async validate(payload: { userId?: string; tv?: number; email?: string }) {
    if (!payload?.userId) {
      throw new UnauthorizedException('Sessão inválida');
    }

    const user = await this.usersService.findById(payload.userId);
    if (!user || user.isActive === false) {
      throw new UnauthorizedException('Conta inativa ou removida');
    }

    const currentVersion = user.tokenVersion ?? 1;
    const tokenVersion = payload.tv ?? 1;
    if (tokenVersion !== currentVersion) {
      throw new UnauthorizedException(
        'Sessão revogada. Faça login novamente para continuar.',
      );
    }

    return { userId: user.id };
  }
}
