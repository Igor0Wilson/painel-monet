import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FamilyModule } from '../family/family.module';
import { DueRemindersCronController } from './due-reminders-cron.controller';
import { DueRemindersService } from './due-reminders.service';
import { ExpensesService } from './expenses.service';
import { ExpensesController } from './expenses.controller';

@Module({
  imports: [FamilyModule, AuthModule],
  providers: [ExpensesService, DueRemindersService],
  controllers: [ExpensesController, DueRemindersCronController],
  exports: [ExpensesService, DueRemindersService],
})
export class ExpensesModule {}
