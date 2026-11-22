import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import type { AuthenticatedRequest } from './auth.types';
import { BiometricService } from './biometric.service';
import {
  BiometricLoginOptionsDto,
  BiometricLoginVerifyDto,
  BiometricRegisterOptionsDto,
  BiometricRegisterVerifyDto,
  UpdateBiometricCredentialDto,
} from './dto/biometric.dto';
import { FirebaseRegisterDto } from './dto/firebase-register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { GoogleCompleteDto } from './dto/google-complete.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly biometricService: BiometricService,
  ) {}

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

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Request() req: AuthenticatedRequest) {
    return this.authService.logout(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('biometric/credentials')
  async listBiometricCredentials(@Request() req: AuthenticatedRequest) {
    return this.biometricService.listCredentials(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 15 } })
  @Post('biometric/register/options')
  async createBiometricRegistrationOptions(
    @Request() req: AuthenticatedRequest,
    @Body() dto: BiometricRegisterOptionsDto,
  ) {
    return this.biometricService.createRegistrationOptions(
      req.user.userId,
      dto,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 15 } })
  @Post('biometric/register/verify')
  async verifyBiometricRegistration(
    @Request() req: AuthenticatedRequest,
    @Body() dto: BiometricRegisterVerifyDto,
  ) {
    return this.biometricService.verifyAndSaveRegistration(
      req.user.userId,
      dto,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch('biometric/credentials/:id')
  async updateBiometricCredential(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateBiometricCredentialDto,
  ) {
    return this.biometricService.updateCredential(req.user.userId, id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('biometric/credentials/:id')
  async deleteBiometricCredential(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.biometricService.deleteCredential(req.user.userId, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('biometric/login/options')
  async createBiometricLoginOptions(@Body() dto: BiometricLoginOptionsDto) {
    return this.biometricService.createLoginOptions(dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('biometric/login/verify')
  async verifyBiometricLogin(@Body() dto: BiometricLoginVerifyDto) {
    const user = await this.biometricService.verifyLoginAssertion(dto);
    return this.authService.issueJwtSession(user);
  }
}
