import { Module } from '@nestjs/common';
import { EmailSenderService } from '../auth/email-sender.service';
import { FamilyService } from './family.service';
import { FamilyEventsService } from './family-events.service';
import { FamilyController } from './family.controller';

@Module({
  providers: [FamilyService, FamilyEventsService, EmailSenderService],
  controllers: [FamilyController],
  exports: [FamilyService, FamilyEventsService],
})
export class FamilyModule { }
