import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class InviteFamilyDto {
  @IsString()
  @IsNotEmpty({ message: 'Informe o CPF do familiar ou cônjuge.' })
  @MaxLength(18)
  cpf: string;
}
