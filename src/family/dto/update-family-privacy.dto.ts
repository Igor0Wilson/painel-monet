import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsString,
  ValidateNested,
} from 'class-validator';

export class MemberPrivacyRuleDto {
  @IsString()
  @IsNotEmpty({ message: 'Informe o participante da família.' })
  targetUserId: string;

  @IsBoolean()
  viewBalance: boolean;

  @IsBoolean()
  viewIncome: boolean;

  @IsBoolean()
  viewExpenses: boolean;

  @IsBoolean()
  viewInvestments: boolean;

  @IsBoolean()
  viewEmergencyFund: boolean;

  @IsBoolean()
  viewFoodAllowance: boolean;
}

export class UpdateFamilyPrivacyDto {
  @IsBoolean()
  fullAccessAll: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MemberPrivacyRuleDto)
  rules: MemberPrivacyRuleDto[];
}
