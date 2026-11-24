import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class FoodExpenseBatchItemDto {
  @IsString()
  @IsNotEmpty({ message: 'Informe a descrição do gasto VA/VR.' })
  @MaxLength(120)
  name: string;

  @IsNumber()
  @Min(0.01, { message: 'O valor do gasto deve ser maior que zero.' })
  amount: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Informe a data no formato YYYY-MM-DD.',
  })
  date: string;

  @IsIn(['va', 'vr'], {
    message: 'Informe va ou vr como forma de pagamento.',
  })
  paymentMethod: 'va' | 'vr';

  @IsOptional()
  @IsString()
  accountTypeId?: string;
}

export class CreateFoodExpensesBatchDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Informe pelo menos um lançamento VA/VR.' })
  @ArrayMaxSize(50, { message: 'Máximo de 50 lançamentos por envio.' })
  @ValidateNested({ each: true })
  @Type(() => FoodExpenseBatchItemDto)
  items: FoodExpenseBatchItemDto[];
}
