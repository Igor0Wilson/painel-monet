import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Max,
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
  @IsInt({ message: 'O número de parcelas deve ser um número inteiro.' })
  @Min(1, { message: 'O número mínimo de parcelas é 1.' })
  @Max(60, { message: 'O número máximo de parcelas é 60.' })
  installments?: number;

  @IsOptional()
  @IsDateString({}, { message: 'Informe uma data válida para a primeira parcela.' })
  firstInstallmentDate?: string;
}
