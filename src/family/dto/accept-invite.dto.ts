import { IsBoolean } from 'class-validator';

export class AcceptInviteDto {
  @IsBoolean({ message: 'Confirmação explícita obrigatória.' })
  confirmed: boolean;
}
