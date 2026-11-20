import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class GoogleCompleteDto {
  @IsString()
  @IsNotEmpty()
  completionToken: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @IsString()
  @MinLength(11)
  @MaxLength(18)
  cpf: string;

  @IsString()
  @MinLength(10)
  @MaxLength(20)
  phone: string;
}
