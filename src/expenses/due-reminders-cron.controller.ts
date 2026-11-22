import {
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { DueRemindersService } from './due-reminders.service';

@Controller('expenses/cron')
export class DueRemindersCronController {
  constructor(private readonly dueRemindersService: DueRemindersService) {}

  private assertAuthorizedCron(authorizationHeader?: string) {
    const expectedSecret = process.env.CRON_SECRET?.trim() || '';
    if (!expectedSecret || expectedSecret.length < 16) {
      throw new UnauthorizedException(
        'CRON_SECRET não configurado no servidor.',
      );
    }

    const token = String(authorizationHeader || '')
      .replace(/^Bearer\s+/i, '')
      .trim();

    const expectedBuf = Buffer.from(expectedSecret, 'utf8');
    const providedBuf = Buffer.from(token, 'utf8');

    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new UnauthorizedException('Token de cron inválido.');
    }
  }

  @Get('due-reminders')
  async triggerDueRemindersGet(
    @Headers('authorization') authorization?: string,
  ) {
    this.assertAuthorizedCron(authorization);
    return this.dueRemindersService.dispatchAllActiveUsersCron();
  }

  @Post('due-reminders')
  async triggerDueRemindersPost(
    @Headers('authorization') authorization?: string,
  ) {
    this.assertAuthorizedCron(authorization);
    return this.dueRemindersService.dispatchAllActiveUsersCron();
  }
}
