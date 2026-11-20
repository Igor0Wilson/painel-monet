import { Module } from '@nestjs/common';
import { FamilyModule } from '../family/family.module';
import { BalanceService } from './balance.service';
import { BalanceController } from './balance.controller';

@Module({
  imports: [FamilyModule],
  providers: [BalanceService],
  controllers: [BalanceController],
  exports: [BalanceService],
})
export class BalanceModule {}
