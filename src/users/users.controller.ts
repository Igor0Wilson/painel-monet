import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Patch,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { UploadedImageFile } from '../common/cloudinary.service';
import { maskCpf, maskEmail, maskPhone } from '../common/cpf.utils';
import { DeactivateAccountDto } from './dto/deactivate-account.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { ExportDataDto } from './dto/export-data.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async me(@Request() req: AuthenticatedRequest) {
    const user = await this.usersService.findById(req.user.userId);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }
    return {
      id: user.id,
      name: user.name,
      maskedEmail: maskEmail(user.email),
      maskedCpf: user.cpf ? maskCpf(user.cpf) : null,
      maskedPhone: maskPhone(user.phone),
      hasCpf: Boolean(user.cpf),
      avatarUrl: user.avatarUrl || null,
    };
  }

  @Get('me/profile')
  async editableProfile(@Request() req: AuthenticatedRequest) {
    return this.usersService.getEditableProfile(req.user.userId);
  }

  @Patch('me')
  async updateProfile(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ) {
    const user = await this.usersService.updateProfile(req.user.userId, dto);
    return {
      id: user.id,
      name: user.name,
      maskedEmail: maskEmail(user.email),
      maskedCpf: user.cpf ? maskCpf(user.cpf) : null,
      maskedPhone: maskPhone(user.phone),
      hasCpf: Boolean(user.cpf),
      avatarUrl: user.avatarUrl || null,
    };
  }

  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 3 * 1024 * 1024 } }),
  )
  async uploadAvatar(
    @Request() req: AuthenticatedRequest,
    @UploadedFile() file: UploadedImageFile,
  ) {
    return this.usersService.updateAvatar(req.user.userId, file);
  }

  @Delete('me/avatar')
  async removeAvatar(@Request() req: AuthenticatedRequest) {
    return this.usersService.removeAvatar(req.user.userId);
  }

  @Post('me/export')
  async exportData(
    @Request() req: AuthenticatedRequest,
    @Body() dto?: ExportDataDto,
  ) {
    return this.usersService.exportAccountData(req.user.userId, dto?.cpf);
  }

  @Post('me/deactivate')
  async deactivate(
    @Request() req: AuthenticatedRequest,
    @Body() dto: DeactivateAccountDto,
  ) {
    return this.usersService.deactivateAccount(req.user.userId, dto.confirmed);
  }

  @Delete('me')
  async removeAccount(
    @Request() req: AuthenticatedRequest,
    @Body() dto: DeleteAccountDto,
  ) {
    return this.usersService.deleteAccountPermanently(
      req.user.userId,
      dto.confirmed,
      dto.confirmText,
    );
  }
}
