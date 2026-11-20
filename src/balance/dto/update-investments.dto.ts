import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateInvestmentsDto {
  @IsNumber()
  @Min(0, { message: 'O valor investido não pode ser negativo' })
  amount: number;

  @IsOptional()
  @IsBoolean()
  fromAvailableBalance?: boolean;

  @IsOptional()
  @IsBoolean()
  reclassifyAllocatedToExternal?: boolean;
}
