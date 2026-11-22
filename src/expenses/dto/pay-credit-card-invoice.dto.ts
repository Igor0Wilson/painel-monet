import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export type CashPaymentMethod = 'dinheiro' | 'pix' | 'debito';

export class PayCreditCardInvoiceDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Informe o mês da fatura no formato AAAA-MM (ex.: 2026-12).',
  })
  month: string;

  @IsOptional()
  @IsIn(['dinheiro', 'pix', 'debito'], {
    message: 'Forma de pagamento da fatura inválida. Use: pix, debito ou dinheiro.',
  })
  paymentMethod?: CashPaymentMethod;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data do pagamento no formato YYYY-MM-DD.',
  })
  paidAt?: string;

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
