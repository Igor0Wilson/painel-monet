import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class SetSecurityPinDto {
  @IsString()
  @Matches(/^\d{4,6}$/, {
    message: 'O código de acesso deve conter de 4 a 6 dígitos numéricos.',
  })
  pin: string;
}

export class VerifySecurityPinDto {
  @IsString()
  @IsNotEmpty({
    message: 'Token de dispositivo ausente para validação do código.',
  })
  @MaxLength(512)
  pinDeviceToken: string;

  @IsString()
  @Matches(/^\d{4,6}$/, {
    message: 'Informe um código numérico de 4 a 6 dígitos.',
  })
  pin: string;
}
