import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BalanceService } from './balance.service';
import { CreateInvestmentItemDto } from './dto/create-investment-item.dto';
import { UpdateEmergencyFundDto } from './dto/update-emergency-fund.dto';
import { UpdateFoodAllowanceDto } from './dto/update-food-allowance.dto';
import { UpdateInvestmentItemDto } from './dto/update-investment-item.dto';
import { UpdateInvestmentsDto } from './dto/update-investments.dto';

@UseGuards(JwtAuthGuard)
@Controller('balance')
export class BalanceController {
  constructor(private readonly service: BalanceService) {}

  @Get()
  getBalance(@Request() req: AuthenticatedRequest, @Query('scope') scope?: string) {
    return this.service.getBalance(req.user.userId, scope);
  }

  @Get('charts')
  getCharts(
    @Request() req: AuthenticatedRequest,
    @Query('month') month?: string,
    @Query('scope') scope?: string,
  ) {
    return this.service.getChartData(req.user.userId, month, scope);
  }

  @Post('emergency-fund')
  updateEmergencyFund(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpdateEmergencyFundDto,
  ) {
    return this.service.updateEmergencyFund(
      req.user.userId,
      dto.amount,
      dto.fromAvailableBalance ?? true,
      dto.reclassifyAllocatedToExternal ?? false,
    );
  }

  @Post('investments')
  updateInvestments(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpdateInvestmentsDto,
  ) {
    return this.service.updateInvestments(
      req.user.userId,
      dto.amount,
      dto.fromAvailableBalance ?? true,
      dto.reclassifyAllocatedToExternal ?? false,
    );
  }

  @Get('investments/items')
  getInvestmentItems(
    @Request() req: AuthenticatedRequest,
    @Query('scope') scope?: string,
  ) {
    return this.service.getInvestmentItems(req.user.userId, scope);
  }

  @Post('investments/items')
  createInvestmentItem(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateInvestmentItemDto,
  ) {
    return this.service.createInvestmentItem(req.user.userId, dto);
  }

  @Patch('investments/items/:id')
  updateInvestmentItem(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateInvestmentItemDto,
  ) {
    return this.service.updateInvestmentItem(req.user.userId, id, dto);
  }

  @Delete('investments/items/:id')
  removeInvestmentItem(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.service.removeInvestmentItem(req.user.userId, id);
  }

  @Post('food-allowance')
  updateFoodAllowance(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpdateFoodAllowanceDto,
  ) {
    return this.service.updateFoodAllowance(
      req.user.userId,
      dto.amount,
      dto.creditDate,
      dto.isRecurring,
    );
  }
}
