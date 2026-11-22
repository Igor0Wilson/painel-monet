import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class AckDueRemindersDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  ids: string[];
}
