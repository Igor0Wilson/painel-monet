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

export class UpdateInvestmentItemDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'O nome não pode ficar vazio.' })
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'A categoria não pode ficar vazia.' })
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01, { message: 'O valor deve ser maior que zero.' })
  amount?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe uma data válida no formato YYYY-MM-DD.',
  })
  investedDate?: string;

  @IsOptional()
  @IsIn(['external', 'balance'])
  source?: InvestmentSource;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;
}
