import { Module } from '@nestjs/common';
import { FamilyService } from './family.service';
import { FamilyEventsService } from './family-events.service';
import { FamilyController } from './family.controller';

@Module({
  providers: [FamilyService, FamilyEventsService],
  controllers: [FamilyController],
  exports: [FamilyService, FamilyEventsService],
})
export class FamilyModule { }
