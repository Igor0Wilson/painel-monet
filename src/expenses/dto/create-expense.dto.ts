import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
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
