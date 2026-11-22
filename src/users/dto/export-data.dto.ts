import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ExportDataDto {
  @IsOptional()
  @IsString()
  @MaxLength(18)
  cpf?: string;
}
