import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { EmailSenderService } from './email-sender.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const secret = process.env.JWT_SECRET?.trim() || '';
        if (!secret || secret.length < 32 || secret.includes('SUBSTITUA')) {
          throw new Error(
            '[SECURITY] JWT_SECRET ausente, fraca ou padrão nas variáveis de ambiente. Configure pelo menos 32 caracteres aleatórios.',
          );
        }
        return {
          secret,
          signOptions: {
            algorithm: 'HS256',
            expiresIn: 60 * 60 * 24 * 7,
          },
          verifyOptions: {
            algorithms: ['HS256'],
          },
        };
      },
    }),
  ],
  providers: [AuthService, EmailSenderService, JwtStrategy],
  controllers: [AuthController],
})
export class AuthModule {}
