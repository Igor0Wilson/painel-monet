import { Module } from '@nestjs/common';
import { AccountTypesService } from './account-types.service';
import { AccountTypesController } from './account-types.controller';

@Module({
  providers: [AccountTypesService],
  controllers: [AccountTypesController],
  exports: [AccountTypesService],
})
export class AccountTypesModule {}
