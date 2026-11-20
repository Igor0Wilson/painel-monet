import { Module } from '@nestjs/common';
import { FamilyModule } from '../family/family.module';
import { IncomeService } from './income.service';
import { IncomeController } from './income.controller';

@Module({
  imports: [FamilyModule],
  providers: [IncomeService],
  controllers: [IncomeController],
  exports: [IncomeService],
})
export class IncomeModule {}
