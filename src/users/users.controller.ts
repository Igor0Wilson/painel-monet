import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DeactivateAccountDto } from './dto/deactivate-account.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Request() req: any) {
    const user = await this.usersService.findById(req.user.userId);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      cpf: user.cpf,
      phone: user.phone,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me')
  async updateProfile(@Request() req: any, @Body() dto: UpdateProfileDto) {
    const user = await this.usersService.updateProfile(req.user.userId, dto);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      cpf: user.cpf,
      phone: user.phone,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/export')
  async exportData(@Request() req: any) {
    return this.usersService.exportAccountData(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('me/deactivate')
  async deactivate(
    @Request() req: any,
    @Body() dto: DeactivateAccountDto,
  ) {
    return this.usersService.deactivateAccount(req.user.userId, dto.confirmed);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('me')
  async removeAccount(@Request() req: any, @Body() dto: DeleteAccountDto) {
    return this.usersService.deleteAccountPermanently(
      req.user.userId,
      dto.confirmed,
      dto.confirmText,
    );
  }
}
