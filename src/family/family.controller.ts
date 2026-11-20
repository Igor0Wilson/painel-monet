import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FamilyService } from './family.service';
import { FamilyEventsService } from './family-events.service';
import { InviteFamilyDto } from './dto/invite-family.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { UpdateFamilyPrivacyDto } from './dto/update-family-privacy.dto';

@UseGuards(JwtAuthGuard)
@Controller('family')
export class FamilyController {
  constructor(
    private readonly familyService: FamilyService,
    private readonly familyEventsService: FamilyEventsService,
  ) { }

  @Get('status')
  getStatus(@Request() req: AuthenticatedRequest) {
    return this.familyService.getStatus(req.user.userId);
  }

  @Get('sync')
  getSyncVersion(@Request() req: AuthenticatedRequest) {
    return this.familyService.getSyncVersion(req.user.userId);
  }

  @Get('stream')
  stream(@Request() req: AuthenticatedRequest, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    if (process.env.VERCEL) {
      res.write(
        `data: ${JSON.stringify({ type: 'connected', mode: 'polling', timestamp: Date.now() })}\n\n`,
      );
      res.end();
      return;
    }

    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

    const sub = this.familyEventsService
      .streamForUser(req.user.userId)
      .subscribe((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sub.unsubscribe();
      res.end();
    });
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('invite')
  invite(@Request() req: AuthenticatedRequest, @Body() dto: InviteFamilyDto) {
    return this.familyService.inviteByCpf(req.user.userId, dto.cpf);
  }

  @Post('invites/:id/accept')
  acceptInvite(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AcceptInviteDto,
  ) {
    return this.familyService.acceptInvite(req.user.userId, id, dto.confirmed);
  }

  @Post('invites/:id/reject')
  rejectInvite(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.familyService.rejectInvite(req.user.userId, id);
  }

  @Delete('invites/:id')
  cancelInvite(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.familyService.cancelInvite(req.user.userId, id);
  }

  @Patch('privacy')
  updatePrivacy(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpdateFamilyPrivacyDto,
  ) {
    return this.familyService.updatePrivacy(req.user.userId, dto);
  }

  @Post('leave')
  leaveFamily(@Request() req: AuthenticatedRequest) {
    return this.familyService.leaveFamily(req.user.userId);
  }
}
