import { IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export class CloseFoodMonthDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Informe o mês de fechamento no formato AAAA-MM.',
  })
  month: string;

  @IsIn(['va', 'vr', 'total'], {
    message: 'Benefício inválido. Use: va, vr ou total.',
  })
  benefit: 'va' | 'vr' | 'total';

  @IsNumber()
  @Min(0, { message: 'O saldo final não pode ser negativo.' })
  actualRemaining: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data de fechamento no formato YYYY-MM-DD.',
  })
  closingDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  note?: string;
}
