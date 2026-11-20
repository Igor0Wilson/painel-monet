import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { FirebaseRegisterDto } from './dto/firebase-register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { GoogleCompleteDto } from './dto/google-complete.dto';
import { GoogleLoginDto } from './dto/google-login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('firebase-login')
  async firebaseLogin(@Body() dto: GoogleLoginDto) {
    return this.authService.loginWithFirebase(dto.idToken);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('firebase-register')
  async firebaseRegister(@Body() dto: FirebaseRegisterDto) {
    return this.authService.registerWithFirebase(dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('google')
  async loginWithGoogle(@Body() dto: GoogleLoginDto) {
    return this.authService.loginWithFirebase(dto.idToken);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('google/complete')
  async completeGoogleProfile(@Body() dto: GoogleCompleteDto) {
    return this.authService.completeGoogleProfile(dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.requestPasswordResetOrReactivation(
      dto.identifier,
      dto.mode || 'reset',
    );
  }
}
