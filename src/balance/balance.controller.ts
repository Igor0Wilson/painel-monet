import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BalanceService } from './balance.service';
import { UpdateEmergencyFundDto } from './dto/update-emergency-fund.dto';
import { UpdateFoodAllowanceDto } from './dto/update-food-allowance.dto';
import { UpdateInvestmentsDto } from './dto/update-investments.dto';

@UseGuards(JwtAuthGuard)
@Controller('balance')
export class BalanceController {
  constructor(private readonly service: BalanceService) {}

  @Get()
  getBalance(@Request() req: any, @Query('scope') scope?: string) {
    return this.service.getBalance(req.user.userId, scope);
  }

  @Get('charts')
  getCharts(
    @Request() req: any,
    @Query('month') month?: string,
    @Query('scope') scope?: string,
  ) {
    return this.service.getChartData(req.user.userId, month, scope);
  }

  @Post('emergency-fund')
  updateEmergencyFund(
    @Request() req: any,
    @Body() dto: UpdateEmergencyFundDto,
  ) {
    return this.service.updateEmergencyFund(req.user.userId, dto.amount);
  }

  @Post('investments')
  updateInvestments(@Request() req: any, @Body() dto: UpdateInvestmentsDto) {
    return this.service.updateInvestments(req.user.userId, dto.amount);
  }

  @Post('food-allowance')
  updateFoodAllowance(@Request() req: any, @Body() dto: UpdateFoodAllowanceDto) {
    return this.service.updateFoodAllowance(
      req.user.userId,
      dto.amount,
      dto.creditDate,
      dto.isRecurring,
    );
  }
}
