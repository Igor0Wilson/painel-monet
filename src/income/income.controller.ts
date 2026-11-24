import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
  Patch,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IncomeService } from './income.service';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';

@UseGuards(JwtAuthGuard)
@Controller('income')
export class IncomeController {
  constructor(private readonly service: IncomeService) {}

  @Get()
  findAll(@Request() req: AuthenticatedRequest, @Query('scope') scope?: string) {
    return this.service.findAll(req.user.userId, scope);
  }

  @Post()
  create(@Body() dto: CreateIncomeDto, @Request() req: AuthenticatedRequest) {
    return this.service.create(dto, req.user.userId);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Query('scope') scope?: 'only_month' | 'from_month' | 'all',
    @Query('month') month?: string,
  ) {
    return this.service.remove(id, req.user.userId, scope, month);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIncomeDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.update(id, dto, req.user.userId);
  }
}
