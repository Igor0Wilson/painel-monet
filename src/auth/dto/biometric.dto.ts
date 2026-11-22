import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import type {
  BiometricKind,
  BiometricPlatform,
  BiometricProtocol,
} from '../../firebase/firebase.types';

export class BiometricRegisterOptionsDto {
  @IsIn(['webauthn', 'native_hmac'])
  protocol: BiometricProtocol;

  @IsIn(['facial', 'fingerprint', 'biometric'])
  kind: BiometricKind;

  @IsIn(['web', 'pwa', 'mobile_ios', 'mobile_android'])
  platform: BiometricPlatform;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  deviceLabel?: string;
}

export class BiometricRegisterVerifyDto {
  @IsString()
  @IsNotEmpty()
  challengeId: string;

  @IsIn(['webauthn', 'native_hmac'])
  protocol: BiometricProtocol;

  @IsIn(['facial', 'fingerprint', 'biometric'])
  kind: BiometricKind;

  @IsIn(['web', 'pwa', 'mobile_ios', 'mobile_android'])
  platform: BiometricPlatform;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  deviceLabel?: string;

  // WebAuthn registration fields
  @IsOptional()
  @IsString()
  @MaxLength(512)
  credentialId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  clientDataJSON?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  attestationObject?: string;

  // Native HMAC mobile registration fields
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message: 'Chave biométrica nativa inválida.',
  })
  nativeSecretHex?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  signature?: string;
}

export class BiometricLoginOptionsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  credentialId: string;
}

export class BiometricLoginVerifyDto {
  @IsString()
  @IsNotEmpty()
  challengeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  credentialId: string;

  // WebAuthn assertion fields
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  clientDataJSON?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  authenticatorData?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  signature?: string;
}

export class UpdateBiometricCredentialDto {
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsIn(['facial', 'fingerprint', 'biometric'])
  kind?: BiometricKind;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  deviceLabel?: string;
}
