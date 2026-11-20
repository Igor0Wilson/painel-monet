import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateEmergencyFundDto {
  @IsNumber()
  @Min(0, { message: 'O valor da reserva não pode ser negativo' })
  amount: number;

  @IsOptional()
  @IsBoolean()
  fromAvailableBalance?: boolean;

  @IsOptional()
  @IsBoolean()
  reclassifyAllocatedToExternal?: boolean;
}
