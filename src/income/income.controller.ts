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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IncomeService } from './income.service';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';

@UseGuards(JwtAuthGuard)
@Controller('income')
export class IncomeController {
  constructor(private readonly service: IncomeService) {}

  @Get()
  findAll(@Request() req: any, @Query('scope') scope?: string) {
    return this.service.findAll(req.user.userId, scope);
  }

  @Post()
  create(@Body() dto: CreateIncomeDto, @Request() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.service.remove(id, req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIncomeDto,
    @Request() req: any,
  ) {
    return this.service.update(id, dto, req.user.userId);
  }
}
