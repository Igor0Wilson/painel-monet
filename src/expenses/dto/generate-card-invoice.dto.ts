import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class GenerateCardInvoiceDto {
  @IsArray()
  @ArrayMinSize(1, {
    message: 'Selecione pelo menos uma conta para gerar a fatura do cartão.',
  })
  @IsString({ each: true })
  expenseIds: string[];

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
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data de vencimento da fatura no formato YYYY-MM-DD.',
  })
  dueDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  installments?: number;
}
