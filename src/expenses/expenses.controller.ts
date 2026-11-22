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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { UploadedImageFile } from '../common/cloudinary.service';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { PayExpenseDto } from './dto/pay-expense.dto';
import { PayExpensesBatchDto } from './dto/pay-expenses-batch.dto';
import { PayCreditCardInvoiceDto } from './dto/pay-credit-card-invoice.dto';

@UseGuards(JwtAuthGuard)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly service: ExpensesService) {}

  @Get()
  findAll(@Request() req: AuthenticatedRequest, @Query('scope') scope?: string) {
    return this.service.findAll(req.user.userId, scope);
  }

  @Post()
  create(@Body() dto: CreateExpenseDto, @Request() req: AuthenticatedRequest) {
    return this.service.create(dto, req.user.userId);
  }

  @Post('credit-card/pay-invoice')
  payCreditCardInvoice(
    @Body() dto: PayCreditCardInvoiceDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.payCreditCardInvoice(req.user.userId, dto);
  }

  @Post('pay-batch')
  payBatch(
    @Body() dto: PayExpensesBatchDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.payBatch(req.user.userId, dto);
  }

  @Patch(':id/pay')
  markAsPaid(
    @Param('id') id: string,
    @Body() dto: PayExpenseDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.markAsPaid(id, req.user.userId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.service.remove(id, req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.update(id, dto, req.user.userId);
  }

  @Post(':id/photo')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 3 * 1024 * 1024 } }),
  )
  uploadPhoto(
    @Param('id') id: string,
    @UploadedFile() file: UploadedImageFile,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.uploadReceiptPhoto(id, req.user.userId, file);
  }

  @Delete(':id/photo')
  removePhoto(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.service.removeReceiptPhoto(id, req.user.userId);
  }
}
