import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export type RecurringEditScope = 'only_month' | 'from_month' | 'all';

export class UpdateIncomeDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsNumber()
  @Min(0.01)
  @IsOptional()
  value?: number;

  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;

  @IsDateString()
  @IsOptional()
  incomeDate?: string;

  @IsOptional()
  @IsIn(['only_month', 'from_month', 'all'], {
    message: 'Escopo de edição inválido. Use: only_month, from_month ou all.',
  })
  editScope?: RecurringEditScope;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Informe o mês de referência no formato AAAA-MM.',
  })
  targetMonth?: string;
}
