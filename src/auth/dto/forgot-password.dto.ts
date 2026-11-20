import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ForgotPasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  identifier: string;

  @IsOptional()
  @IsIn(['reset', 'reactivate'])
  mode?: 'reset' | 'reactivate';
}
