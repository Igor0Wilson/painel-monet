import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

export class DeleteAccountDto {
  @IsBoolean()
  confirmed: boolean;

  @IsString()
  @IsNotEmpty()
  confirmText: string;
}
