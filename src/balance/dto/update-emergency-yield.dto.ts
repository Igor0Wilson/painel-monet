import { IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export class UpdateEmergencyYieldDto {
  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'O novo saldo total da reserva não pode ser negativo.' })
  newTotal?: number;

  @IsOptional()
  @IsNumber()
  yieldAmount?: number;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Informe o mês de referência no formato AAAA-MM.',
  })
  month?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data no formato YYYY-MM-DD.',
  })
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  note?: string;
}
