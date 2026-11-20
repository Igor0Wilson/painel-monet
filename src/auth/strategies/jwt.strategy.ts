import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly usersService: UsersService) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        '[SECURITY] JWT_SECRET não está definido nas variáveis de ambiente.',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      algorithms: ['HS256'],
    });
  }

  async validate(payload: { userId?: string; email?: string }) {
    if (!payload?.userId) {
      throw new UnauthorizedException('Sessão inválida');
    }

    const user = await this.usersService.findById(payload.userId);
    if (!user || user.isActive === false) {
      throw new UnauthorizedException('Conta inativa ou removida');
    }

    return { userId: user.id, email: user.email };
  }
}
