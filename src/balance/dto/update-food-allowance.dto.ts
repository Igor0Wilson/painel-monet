import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

export class SingleFoodBenefitDto {
  @IsBoolean()
  enabled: boolean;

  @IsNumber()
  @Min(0, { message: 'O valor do benefício não pode ser negativo' })
  amount: number;

  @IsDateString({}, { message: 'Informe uma data válida para o recebimento' })
  creditDate: string;

  @IsBoolean()
  isRecurring: boolean;

  @IsOptional()
  @IsIn(['fixed', 'variable'])
  mode?: 'fixed' | 'variable';
}

export class UpdateFoodAllowanceDto {
  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'O valor do Vale Alimentação/Refeição não pode ser negativo' })
  amount?: number;

  @IsOptional()
  @IsDateString({}, { message: 'Informe uma data válida para o recebimento do VA/VR' })
  creditDate?: string;

  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @IsOptional()
  @IsIn(['combined', 'va', 'vr'])
  benefit?: 'combined' | 'va' | 'vr';

  @IsOptional()
  @IsIn(['fixed', 'variable'])
  mode?: 'fixed' | 'variable';

  @IsOptional()
  @IsIn(['only_month', 'from_month', 'all'])
  editScope?: 'only_month' | 'from_month' | 'all';

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Informe o mês de referência no formato AAAA-MM.',
  })
  targetMonth?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SingleFoodBenefitDto)
  va?: SingleFoodBenefitDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SingleFoodBenefitDto)
  vr?: SingleFoodBenefitDto;
}
