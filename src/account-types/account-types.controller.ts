import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AccountTypesService } from './account-types.service';
import { CreateAccountTypeDto } from './dto/create-account-type.dto';

@UseGuards(JwtAuthGuard)
@Controller('account-types')
export class AccountTypesController {
  constructor(private readonly service: AccountTypesService) {}

  @Get()
  findAll(@Request() req: AuthenticatedRequest) {
    return this.service.findAll(req.user.userId);
  }

  @Post()
  create(@Body() dto: CreateAccountTypeDto, @Request() req: AuthenticatedRequest) {
    return this.service.create(dto, req.user.userId);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.service.delete(id, req.user.userId);
  }
}
