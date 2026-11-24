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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { UploadedImageFile } from '../common/cloudinary.service';
import { DueRemindersService } from './due-reminders.service';
import { ExpensesService } from './expenses.service';
import { AckDueRemindersDto } from './dto/ack-due-reminders.dto';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { CreateFoodExpensesBatchDto } from './dto/food-expenses.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { PayExpenseDto } from './dto/pay-expense.dto';
import { PayExpensesBatchDto } from './dto/pay-expenses-batch.dto';
import { PayCreditCardInvoiceDto } from './dto/pay-credit-card-invoice.dto';
import { GenerateCardInvoiceDto } from './dto/generate-card-invoice.dto';
import { UndoPaymentDto } from './dto/undo-payment.dto';

@UseGuards(JwtAuthGuard)
@Controller('expenses')
export class ExpensesController {
  constructor(
    private readonly service: ExpensesService,
    private readonly dueRemindersService: DueRemindersService,
  ) {}

  @Get()
  findAll(@Request() req: AuthenticatedRequest, @Query('scope') scope?: string) {
    return this.service.findAll(req.user.userId, scope);
  }

  @Get('due-reminders')
  checkDueReminders(@Request() req: AuthenticatedRequest) {
    return this.dueRemindersService.checkAndDispatchUserReminders(
      req.user.userId,
      { sendEmails: true },
    );
  }

  @Post('due-reminders/ack')
  acknowledgeDueReminders(
    @Body() dto: AckDueRemindersDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.dueRemindersService.acknowledgeDeviceNotifications(
      req.user.userId,
      dto.ids,
    );
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

  @Post('credit-card/generate-invoice')
  generateCardInvoice(
    @Body() dto: GenerateCardInvoiceDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.generateCardInvoice(req.user.userId, dto);
  }

  @Post('pay-batch')
  payBatch(
    @Body() dto: PayExpensesBatchDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.payBatch(req.user.userId, dto);
  }

  @Post('food-allowance/batch')
  createFoodExpensesBatch(
    @Body() dto: CreateFoodExpensesBatchDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.createFoodExpensesBatch(req.user.userId, dto);
  }

  @Patch(':id/pay')
  markAsPaid(
    @Param('id') id: string,
    @Body() dto: PayExpenseDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.markAsPaid(id, req.user.userId, dto);
  }

  @Patch(':id/undo-pay')
  undoPayment(
    @Param('id') id: string,
    @Body() dto: UndoPaymentDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.undoPayment(id, req.user.userId, dto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Query('scope') scope?: 'only_month' | 'from_month' | 'all' | 'all_installments',
    @Query('month') month?: string,
  ) {
    return this.service.remove(id, req.user.userId, scope, month);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.service.update(id, dto, req.user.userId);
  }

  @Get(':id/photo')
  async getPhoto(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const media = await this.service.getDecryptedReceiptPhoto(
      id,
      req.user.userId,
    );
    res.setHeader('Content-Type', media.mime);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="receipt-${id.replace(/[^a-zA-Z0-9_-]/g, '')}.${media.ext}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(media.buffer);
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
