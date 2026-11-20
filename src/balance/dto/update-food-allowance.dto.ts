import { IsBoolean, IsDateString, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateFoodAllowanceDto {
  @IsNumber()
  @Min(0, { message: 'O valor do Vale Alimentação/Refeição não pode ser negativo' })
  amount: number;

  @IsOptional()
  @IsDateString({}, { message: 'Informe uma data válida para o recebimento do VA/VR' })
  creditDate?: string;

  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
