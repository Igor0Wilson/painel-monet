import { IsNumber, Min } from 'class-validator';

export class UpdateInvestmentsDto {
  @IsNumber()
  @Min(0, { message: 'O valor investido não pode ser negativo' })
  amount: number;
}
