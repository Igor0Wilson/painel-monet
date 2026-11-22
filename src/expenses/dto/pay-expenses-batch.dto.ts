import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import type { PaymentMethod } from './pay-expense.dto';

export class PayExpensesBatchDto {
  @IsArray()
  @ArrayMinSize(1, {
    message: 'Selecione pelo menos uma despesa para pagar em lote.',
  })
  @IsString({ each: true })
  expenseIds: string[];

  @IsIn(['dinheiro', 'pix', 'debito', 'credito', 'va', 'vr'])
  paymentMethod: PaymentMethod;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  installments?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data no formato YYYY-MM-DD.',
  })
  firstInstallmentDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data do pagamento no formato YYYY-MM-DD.',
  })
  paidAt?: string;
}
