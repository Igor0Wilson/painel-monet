import { IsOptional, IsString } from 'class-validator';

export class UndoPaymentDto {
  @IsOptional()
  @IsString()
  paymentId?: string;
}
