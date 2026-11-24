import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class InvestmentBalanceUpdateItemDto {
  @IsString()
  id: string;

  @IsNumber()
  @Min(0, { message: 'O saldo atualizado do investimento não pode ser negativo.' })
  newAmount: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  note?: string;
}

export class BatchUpdateInvestmentsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Informe pelo menos um investimento para atualizar.' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => InvestmentBalanceUpdateItemDto)
  updates: InvestmentBalanceUpdateItemDto[];

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Informe o mês de referência no formato AAAA-MM.',
  })
  month?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data no formato YYYY-MM-DD.',
  })
  date?: string;
}
