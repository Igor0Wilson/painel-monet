import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type { InvestmentSource } from '../../firebase/firebase.types';

export class CreateInvestmentItemDto {
  @IsString()
  @IsNotEmpty({ message: 'Informe o nome do investimento ou ativo.' })
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Informe a categoria do investimento.' })
  @MaxLength(60)
  category: string;

  @IsNumber()
  @Min(0.01, { message: 'O valor do investimento deve ser maior que zero.' })
  amount: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe uma data válida no formato YYYY-MM-DD.',
  })
  investedDate: string;

  @IsIn(['external', 'balance'], {
    message: 'Origem deve ser carteira já existente (external) ou saldo do mês (balance).',
  })
  source: InvestmentSource;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;
}
