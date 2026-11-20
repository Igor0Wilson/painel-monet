import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { FamilyModule } from '../family/family.module';
import { IncomeService } from './income.service';
import { IncomeController } from './income.controller';

@Module({
  imports: [FamilyModule, BalanceModule],
  providers: [IncomeService],
  controllers: [IncomeController],
  exports: [IncomeService],
})
export class IncomeModule { }
