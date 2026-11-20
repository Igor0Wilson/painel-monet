import { IsBoolean } from 'class-validator';

export class DeactivateAccountDto {
  @IsBoolean()
  confirmed: boolean;
}
