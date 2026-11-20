import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { isValidCpf, normalizeCpf, normalizePhone } from '../common/cpf.utils';
import { FirebaseService } from '../firebase/firebase.service';
import { COLLECTIONS, UserDoc } from '../firebase/firebase.types';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(private readonly firebase: FirebaseService) {}

  async create(dto: CreateUserDto): Promise<UserDoc> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.firebase.findOneByField<UserDoc>(
      COLLECTIONS.USERS,
      'email',
      normalizedEmail,
    );
    if (existing) {
      throw new ConflictException('Não foi possível concluir o cadastro');
    }

    let normalizedCpf: string | null = null;
    if (dto.cpf && dto.cpf.trim()) {
      normalizedCpf = normalizeCpf(dto.cpf);
      if (!isValidCpf(normalizedCpf)) {
        throw new BadRequestException('CPF inválido. Verifique os 11 dígitos.');
      }
      const existingCpf = await this.firebase.findOneByField<UserDoc>(
        COLLECTIONS.USERS,
        'cpf',
        normalizedCpf,
      );
      if (existingCpf) {
        throw new ConflictException(
          'Não foi possível concluir o cadastro com este CPF',
        );
      }
    }

    const normalizedPhone = dto.phone?.trim()
      ? normalizePhone(dto.phone)
      : null;

    const hashed = await bcrypt.hash(dto.password, 12);
    const now = new Date().toISOString();

    const user: UserDoc = {
      id: uuidv4(),
      name: dto.name.trim(),
      email: normalizedEmail,
      password: hashed,
      cpf: normalizedCpf,
      phone: normalizedPhone,
      emergencyFund: 0,
      investments: 0,
      createdAt: now,
      updatedAt: now,
    };

    return this.firebase.setDoc(COLLECTIONS.USERS, user);
  }

  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.firebase.findOneByField<UserDoc>(
      COLLECTIONS.USERS,
      'email',
      email.trim().toLowerCase(),
    );
  }

  async findById(id: string): Promise<UserDoc | null> {
    return this.firebase.findById<UserDoc>(COLLECTIONS.USERS, id);
  }

  async findByCpf(rawCpf: string): Promise<UserDoc | null> {
    const cpf = normalizeCpf(rawCpf);
    if (!cpf) return null;
    return this.firebase.findOneByField<UserDoc>(COLLECTIONS.USERS, 'cpf', cpf);
  }

  async updateProfile(id: string, dto: UpdateProfileDto): Promise<UserDoc> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const updateData: Partial<UserDoc> = {
      updatedAt: new Date().toISOString(),
    };

    if (dto.email !== undefined) {
      const normalizedEmail = dto.email.trim().toLowerCase();
      if (normalizedEmail !== user.email) {
        const existing = await this.findByEmail(normalizedEmail);
        if (existing) {
          throw new ConflictException('Não foi possível atualizar o e-mail');
        }
      }
      updateData.email = normalizedEmail;
    }

    if (dto.name !== undefined) {
      updateData.name = dto.name.trim();
    }

    if (dto.password !== undefined) {
      updateData.password = await bcrypt.hash(dto.password, 12);
    }

    if (dto.cpf !== undefined) {
      const trimmedCpf = dto.cpf.trim();
      if (!trimmedCpf) {
        updateData.cpf = null;
      } else {
        const normalized = normalizeCpf(trimmedCpf);
        if (!isValidCpf(normalized)) {
          throw new BadRequestException('CPF inválido. Verifique os 11 dígitos.');
        }
        if (normalized !== user.cpf) {
          const existingCpf = await this.firebase.findOneByField<UserDoc>(
            COLLECTIONS.USERS,
            'cpf',
            normalized,
          );
          if (existingCpf && existingCpf.id !== user.id) {
            throw new ConflictException(
              'Este CPF já está vinculado a outra conta',
            );
          }
        }
        updateData.cpf = normalized;
      }
    }

    if (dto.phone !== undefined) {
      const normalizedPhone = normalizePhone(dto.phone);
      updateData.phone = normalizedPhone || null;
    }

    await this.firebase.updateDoc(COLLECTIONS.USERS, user.id, updateData);
    return { ...user, ...updateData };
  }
}
