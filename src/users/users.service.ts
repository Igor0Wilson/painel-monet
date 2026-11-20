import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomUUID as uuidv4 } from 'crypto';
import { isValidCpf, normalizeCpf, normalizePhone } from '../common/cpf.utils';
import { FirebaseService } from '../firebase/firebase.service';
import {
  AccountTypeDoc,
  COLLECTIONS,
  ExpenseDoc,
  FamilyInviteDoc,
  FamilyMemberDoc,
  IncomeDoc,
  UserDoc,
} from '../firebase/firebase.types';
import { UpdateProfileDto } from './dto/update-profile.dto';

export interface RegisterFirebaseUserParams {
  email: string;
  firebaseUid: string;
  authProvider: 'password' | 'google';
  name: string;
  cpf: string;
  phone: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly firebase: FirebaseService) {}

  async createFromFirebase(params: RegisterFirebaseUserParams): Promise<UserDoc> {
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
      if (
        existingByEmail.cpf &&
        existingByEmail.phone &&
        existingByEmail.name?.trim() &&
        existingByEmail.isActive !== false
      ) {
        throw new ConflictException({
          message: 'Este e-mail já está cadastrado em outra conta.',
          code: 'EMAIL_ALREADY_EXISTS',
        });
      }

      return this.firebase.updateUserWithAtomicLocks(
        existingByEmail.id,
        existingByEmail,
        {
          name: trimmedName,
          cpf: normalizedCpf,
          phone: normalizedPhone,
          firebaseUid: params.firebaseUid,
          authProvider: params.authProvider,
          updatedAt: now,
        },
      );
    }

    const user: UserDoc = {
      id: uuidv4(),
      name: trimmedName,
      email: normalizedEmail,
      cpf: normalizedCpf,
      phone: normalizedPhone,
      firebaseUid: params.firebaseUid,
      authProvider: params.authProvider,
      isActive: true,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 0,
      investments: 0,
      createdAt: now,
      updatedAt: now,
    };

    return this.firebase.createUserWithAtomicLocks(user);
  }

  async linkFirebaseUid(userId: string, firebaseUid: string): Promise<void> {
    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      firebaseUid,
      updatedAt: new Date().toISOString(),
    });
  }

  async reactivateUser(userId: string): Promise<void> {
    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      isActive: true,
      deactivatedAt: null,
      deactivatedAtMs: null,
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

  async findByFirebaseUid(firebaseUid: string): Promise<UserDoc | null> {
    if (!firebaseUid) return null;
    return this.firebase.findOneByField<UserDoc>(
      COLLECTIONS.USERS,
      'firebaseUid',
      firebaseUid,
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

  private async resolveFirebaseUid(user: UserDoc): Promise<string | null> {
    if (user.firebaseUid) return user.firebaseUid;
    try {
      const fbUser = await this.firebase.lookupFirebaseUser({
        email: user.email,
      });
      return fbUser?.localId || null;
    } catch {
      return null;
    }
  }

  async updateProfile(id: string, dto: UpdateProfileDto): Promise<UserDoc> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const updateData: Partial<UserDoc> = {
      updatedAt: new Date().toISOString(),
    };

    let nextEmail: string | undefined;
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
        nextEmail = normalizedEmail;
      }
      updateData.email = normalizedEmail;
    }

    if (dto.name !== undefined) {
      updateData.name = dto.name.trim();
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

    const updated = await this.firebase.updateUserWithAtomicLocks(
      user.id,
      user,
      updateData,
    );

    if (dto.password || nextEmail || dto.name !== undefined) {
      const uid = await this.resolveFirebaseUid(user);
      if (uid) {
        try {
          await this.firebase.updateFirebaseUser(uid, {
            ...(dto.password ? { password: dto.password } : {}),
            ...(nextEmail ? { email: nextEmail } : {}),
            ...(dto.name !== undefined ? { displayName: dto.name.trim() } : {}),
          });
        } catch (error) {
          this.logger.warn(
            `Não foi possível sincronizar atualização com Firebase Auth: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return updated;
  }

  async exportAccountData(userId: string) {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const [categories, incomes, expenses] = await Promise.all([
      this.firebase.findByField<AccountTypeDoc>(
        COLLECTIONS.ACCOUNT_TYPES,
        'userId',
        userId,
      ),
      this.firebase.findByField<IncomeDoc>(COLLECTIONS.INCOME, 'userId', userId),
      this.firebase.findByField<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        userId,
      ),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      application: 'Painel Monet',
      profile: {
        id: user.id,
        name: user.name,
        email: user.email,
        cpf: user.cpf,
        phone: user.phone,
        authProvider: user.authProvider || 'password',
        createdAt: user.createdAt,
      },
      summary: {
        emergencyFund: Number(user.emergencyFund || 0),
        investments: Number(user.investments || 0),
        totalCategories: categories.length,
        totalIncomes: incomes.length,
        totalExpenses: expenses.length,
      },
      categories,
      incomes,
      expenses,
    };
  }

  async deactivateAccount(userId: string, confirmed: boolean) {
    if (!confirmed) {
      throw new BadRequestException(
        'Confirme explicitamente que deseja desativar sua conta.',
      );
    }

    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const uid = await this.resolveFirebaseUid(user);
    if (uid) {
      const scrambledPassword = randomBytes(32).toString('hex');
      const nowSec = Math.floor(Date.now() / 1000);
      await this.firebase.updateFirebaseUser(uid, {
        password: scrambledPassword,
        validSince: nowSec,
      });
    }

    const now = new Date();
    const deactivatedAtMs = now.getTime() + 1500;

    await this.firebase.updateDoc(COLLECTIONS.USERS, user.id, {
      isActive: false,
      deactivatedAt: now.toISOString(),
      deactivatedAtMs,
      updatedAt: now.toISOString(),
    });

    return {
      message:
        'Sua conta foi desativada com segurança. Para reativar no futuro, solicite o e-mail de reativação na tela de login para definir uma nova senha.',
    };
  }

  async deleteAccountPermanently(
    userId: string,
    confirmed: boolean,
    confirmText: string,
  ) {
    if (!confirmed || confirmText.trim().toUpperCase() !== 'EXCLUIR') {
      throw new BadRequestException(
        'Confirmação inválida. Digite EXCLUIR para confirmar a exclusão permanente.',
      );
    }

    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const uid = await this.resolveFirebaseUid(user);

    const [
      expenses,
      incomes,
      accountTypes,
      memberships,
      sentInvites,
      receivedInvites,
    ] = await Promise.all([
      this.firebase.findByField<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        userId,
      ),
      this.firebase.findByField<IncomeDoc>(COLLECTIONS.INCOME, 'userId', userId),
      this.firebase.findByField<AccountTypeDoc>(
        COLLECTIONS.ACCOUNT_TYPES,
        'userId',
        userId,
      ),
      this.firebase.findByField<FamilyMemberDoc>(
        COLLECTIONS.FAMILY_MEMBERS,
        'userId',
        userId,
      ),
      this.firebase.findByField<FamilyInviteDoc>(
        COLLECTIONS.FAMILY_INVITES,
        'inviterUserId',
        userId,
      ),
      this.firebase.findByField<FamilyInviteDoc>(
        COLLECTIONS.FAMILY_INVITES,
        'inviteeUserId',
        userId,
      ),
    ]);

    const affectedGroupIds = Array.from(
      new Set(memberships.map((m) => m.familyGroupId).filter(Boolean)),
    );

    await Promise.all([
      ...expenses.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.EXPENSES, doc.id),
      ),
      ...incomes.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.INCOME, doc.id),
      ),
      ...accountTypes.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.ACCOUNT_TYPES, doc.id),
      ),
      ...memberships.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.FAMILY_MEMBERS, doc.id),
      ),
      ...sentInvites.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.FAMILY_INVITES, doc.id),
      ),
      ...receivedInvites.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.FAMILY_INVITES, doc.id),
      ),
    ]);

    for (const groupId of affectedGroupIds) {
      const remaining = await this.firebase.findByField<FamilyMemberDoc>(
        COLLECTIONS.FAMILY_MEMBERS,
        'familyGroupId',
        groupId,
      );
      if (remaining.length === 0) {
        await this.firebase.deleteDoc(COLLECTIONS.FAMILY_GROUPS, groupId);
      }
    }

    await this.firebase.deleteUserAndLocks(user);

    if (uid) {
      await this.firebase.deleteFirebaseUser(uid);
    }

    return {
      message:
        'Conta, dados financeiros e acesso no Firebase excluídos permanentemente.',
    };
  }
}
