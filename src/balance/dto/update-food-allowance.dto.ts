import { IsNumber, Min } from 'class-validator';

export class UpdateFoodAllowanceDto {
  @IsNumber()
  @Min(0, { message: 'O valor do Vale Alimentação/Refeição não pode ser negativo' })
  amount: number;
}
