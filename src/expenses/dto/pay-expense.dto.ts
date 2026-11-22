import {
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

export type PaymentMethod = 'dinheiro' | 'pix' | 'debito' | 'credito' | 'va' | 'vr';

export class PayExpenseDto {
  @IsOptional()
  @IsIn(['dinheiro', 'pix', 'debito', 'credito', 'va', 'vr'], {
    message: 'Forma de pagamento inválida. Use: dinheiro, pix, debito, credito, va ou vr.',
  })
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsNumber({}, { message: 'Informe um valor numérico válido.' })
  @Min(0.01, { message: 'O valor do pagamento deve ser maior que zero.' })
  amount?: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data do pagamento no formato YYYY-MM-DD.',
  })
  paidAt?: string;

  @IsOptional()
  @IsInt({ message: 'O número de parcelas deve ser um número inteiro.' })
  @Min(1, { message: 'O número mínimo de parcelas é 1.' })
  @Max(60, { message: 'O número máximo de parcelas é 60.' })
  installments?: number;

  @IsOptional()
  @IsDateString({}, { message: 'Informe uma data válida para a primeira parcela.' })
  firstInstallmentDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  cardBank?: string;

  @IsOptional()
  @Matches(/^$|^\d{4}$/, {
    message: 'Informe os 4 últimos dígitos do cartão (apenas números).',
  })
  cardLast4?: string;
}
