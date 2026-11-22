import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import type { PaymentMethod } from './pay-expense.dto';

export class CreateExpenseDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  accountTypeId: string;

  @IsNumber()
  @Min(0.01)
  value: number;

  @IsDateString()
  dueDate: string;

  @IsBoolean()
  isRecurring: boolean;

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

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  paidAmount?: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data de pagamento no formato YYYY-MM-DD.',
  })
  paidAt?: string;

  @IsBoolean()
  @IsOptional()
  isCreditCard?: boolean;

  @IsOptional()
  @IsIn(['dinheiro', 'pix', 'debito', 'credito', 'va', 'vr'])
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsDateString()
  firstInstallmentDate?: string;
}
