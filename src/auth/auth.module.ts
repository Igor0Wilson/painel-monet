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
        const secret = process.env.JWT_SECRET;
        if (!secret) {
          throw new Error(
            '[SECURITY] JWT_SECRET não está definido nas variáveis de ambiente. ' +
              'O servidor não pode iniciar sem um segredo JWT forte.',
          );
        }
        return {
          secret,
          signOptions: {
            algorithm: 'HS256',
            expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any,
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
