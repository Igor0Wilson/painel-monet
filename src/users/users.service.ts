import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID as uuidv4 } from 'crypto';
import { isValidCpf, normalizeCpf, normalizePhone } from '../common/cpf.utils';
import { FirebaseService } from '../firebase/firebase.service';
import { COLLECTIONS, FamilyMemberDoc, UserDoc } from '../firebase/firebase.types';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

export interface CompleteGoogleUserParams {
  email: string;
  googleUid: string;
  name: string;
  cpf: string;
  phone: string;
}

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
      throw new ConflictException({
        message: 'Este e-mail já está cadastrado em outra conta.',
        code: 'EMAIL_ALREADY_EXISTS',
      });
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
        throw new ConflictException({
          message: 'Este CPF já está cadastrado em outra conta.',
          code: 'CPF_ALREADY_EXISTS',
        });
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
      googleUid: null,
      authProvider: 'local',
      emergencyFund: 0,
      investments: 0,
      createdAt: now,
      updatedAt: now,
    };

    return this.firebase.createUserWithAtomicLocks(user);
  }

  async createOrCompleteGoogleUser(
    params: CompleteGoogleUserParams,
  ): Promise<UserDoc> {
    const normalizedEmail = params.email.trim().toLowerCase();
    const trimmedName = params.name.trim();
    if (trimmedName.length < 2) {
      throw new BadRequestException('Informe seu nome completo.');
    }

    const normalizedCpf = normalizeCpf(params.cpf);
    if (!isValidCpf(normalizedCpf)) {
      throw new BadRequestException('CPF inválido. Verifique os 11 dígitos.');
    }

    const normalizedPhone = normalizePhone(params.phone);
    if (normalizedPhone.length < 10) {
      throw new BadRequestException(
        'Telefone inválido. Informe DDD + número.',
      );
    }

    const existingByEmail = await this.findByEmail(normalizedEmail);
    const existingByCpf = await this.findByCpf(normalizedCpf);

    if (
      existingByCpf &&
      (!existingByEmail || existingByCpf.id !== existingByEmail.id)
    ) {
      throw new ConflictException({
        message: 'Este CPF já está cadastrado em outra conta.',
        code: 'CPF_ALREADY_EXISTS',
      });
    }

    const now = new Date().toISOString();

    if (existingByEmail) {
      return this.firebase.updateUserWithAtomicLocks(
        existingByEmail.id,
        existingByEmail,
        {
          name: trimmedName,
          cpf: normalizedCpf,
          phone: normalizedPhone,
          googleUid: params.googleUid,
          authProvider: existingByEmail.authProvider || 'google',
          updatedAt: now,
        },
      );
    }

    const randomPassword = randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, 12);

    const user: UserDoc = {
      id: uuidv4(),
      name: trimmedName,
      email: normalizedEmail,
      password: hashedPassword,
      cpf: normalizedCpf,
      phone: normalizedPhone,
      googleUid: params.googleUid,
      authProvider: 'google',
      emergencyFund: 0,
      investments: 0,
      createdAt: now,
      updatedAt: now,
    };

    return this.firebase.createUserWithAtomicLocks(user);
  }

  async linkGoogleUid(userId: string, googleUid: string): Promise<void> {
    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      googleUid,
      updatedAt: new Date().toISOString(),
    });
  }

  async updatePassword(userId: string, newPassword: string): Promise<void> {
    const hashed = await bcrypt.hash(newPassword, 12);
    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      password: hashed,
      updatedAt: new Date().toISOString(),
    });
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
          throw new ConflictException({
            message: 'Este e-mail já está vinculado a outra conta.',
            code: 'EMAIL_ALREADY_EXISTS',
          });
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
      const nextCpf = trimmedCpf ? normalizeCpf(trimmedCpf) : null;

      if (nextCpf && !isValidCpf(nextCpf)) {
        throw new BadRequestException('CPF inválido. Verifique os 11 dígitos.');
      }

      if (nextCpf !== user.cpf) {
        const membership = await this.firebase.findOneByField<FamilyMemberDoc>(
          COLLECTIONS.FAMILY_MEMBERS,
          'userId',
          user.id,
        );
        if (membership) {
          throw new BadRequestException(
            'Saia do Modo Família antes de alterar ou remover seu CPF.',
          );
        }

        if (nextCpf) {
          const existingCpf = await this.firebase.findOneByField<UserDoc>(
            COLLECTIONS.USERS,
            'cpf',
            nextCpf,
          );
          if (existingCpf && existingCpf.id !== user.id) {
            throw new ConflictException({
              message: 'Este CPF já está cadastrado em outra conta.',
              code: 'CPF_ALREADY_EXISTS',
            });
          }
        }
      }

      updateData.cpf = nextCpf;
    }

    if (dto.phone !== undefined) {
      const normalizedPhone = normalizePhone(dto.phone);
      updateData.phone = normalizedPhone || null;
    }

    return this.firebase.updateUserWithAtomicLocks(user.id, user, updateData);
  }
}
