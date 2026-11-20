import { IsNumber, Min } from 'class-validator';

export class UpdateEmergencyFundDto {
  @IsNumber()
  @Min(0, { message: 'O valor da reserva não pode ser negativo' })
  amount: number;
}
