import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { PaymentMethod } from './pay-expense.dto';

export class UpdateExpenseDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  accountTypeId?: string;

  @IsNumber()
  @Min(0.01)
  @IsOptional()
  value?: number;

  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;

  @IsBoolean()
  @IsOptional()
  isInstallment?: boolean;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(60)
  installmentCount?: number;

  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;

  @IsBoolean()
  @IsOptional()
  isCreditCard?: boolean;

  @IsOptional()
  @IsIn(['dinheiro', 'pix', 'debito', 'credito', 'va', 'vr'])
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data de pagamento no formato YYYY-MM-DD.',
  })
  paidAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  pixKey?: string;

  @IsBoolean()
  @IsOptional()
  isAutoDebit?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  cardBank?: string;

  @IsOptional()
  @Matches(/^$|^\d{4}$/, {
    message: 'Informe os 4 últimos dígitos do cartão (apenas números).',
  })
  cardLast4?: string;

  @IsOptional()
  @IsIn(['only_month', 'from_month', 'all', 'all_installments'], {
    message:
      'Escopo de edição inválido. Use: only_month, from_month, all ou all_installments.',
  })
  editScope?: 'only_month' | 'from_month' | 'all' | 'all_installments';

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Informe o mês de referência no formato AAAA-MM.',
  })
  targetMonth?: string;
}
