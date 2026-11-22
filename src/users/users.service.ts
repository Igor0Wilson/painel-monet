import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes, randomUUID as uuidv4 } from 'crypto';
import { normalizeOfficialCategory } from '../account-types/account-types.service';
import { AuditService } from '../common/audit.service';
import {
  buildProtectedMediaPath,
  CloudinaryService,
  type UploadedImageFile,
} from '../common/cloudinary.service';
import type { DecryptedMediaPayload } from '../common/data-crypto.utils';
import {
  isValidCpf,
  maskCpf,
  maskEmail,
  maskPhone,
  normalizeCpf,
  normalizePhone,
} from '../common/cpf.utils';
import {
  computeBlindIndex,
  computeDeterministicHash,
  redactSensitiveText,
} from '../common/data-crypto.utils';
import { FirebaseService } from '../firebase/firebase.service';
import {
  AccountTypeDoc,
  BiometricChallengeDoc,
  BiometricCredentialDoc,
  COLLECTIONS,
  ExpenseDoc,
  ExpenseReminderDoc,
  FamilyInviteDoc,
  FamilyMemberDoc,
  IncomeDoc,
  InvestmentDoc,
  UserDoc,
} from '../firebase/firebase.types';
import { evaluateIncomeCredit, getTodayParts } from '../income/income.date-utils';
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

  constructor(
    private readonly firebase: FirebaseService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly cloudinaryService?: CloudinaryService,
  ) { }

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
      tokenVersion: 1,
      deactivatedAt: null,
      deactivatedAtMs: null,
      emergencyFund: 0,
      externalEmergencyFund: 0,
      investments: 0,
      externalInvestments: 0,
      foodAllowance: 0,
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

  async getEditableProfile(userId: string) {
    const user = await this.findById(userId);
    if (!user || user.isActive === false) {
      throw new NotFoundException('Usuário não encontrado');
    }

    void this.auditService?.log({
      actorUserId: userId,
      action: 'users.profile.read_sensitive',
      resource: 'users',
      resourceId: user.id,
      outcome: 'ALLOW',
    });

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      cpf: user.cpf,
      phone: user.phone,
      maskedEmail: maskEmail(user.email),
      maskedCpf: user.cpf ? maskCpf(user.cpf) : null,
      maskedPhone: maskPhone(user.phone),
      hasCpf: Boolean(user.cpf),
      avatarUrl: buildProtectedMediaPath(
        'avatar',
        user.id,
        user.avatarUrl,
        user.avatarPublicId,
      ),
    };
  }

  async updateAvatar(userId: string, file: UploadedImageFile) {
    const user = await this.findById(userId);
    if (!user || user.isActive === false) {
      throw new NotFoundException('Usuário não encontrado');
    }
    if (!this.cloudinaryService) {
      throw new BadRequestException(
        'Serviço de armazenamento de imagens indisponível.',
      );
    }

    const uploaded = await this.cloudinaryService.uploadImage(
      file,
      'avatars',
      userId,
    );
    const previousPublicId = user.avatarPublicId || null;

    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      avatarUrl: uploaded.url,
      avatarPublicId: uploaded.publicId,
      updatedAt: new Date().toISOString(),
    });

    if (previousPublicId && previousPublicId !== uploaded.publicId) {
      await this.cloudinaryService.deleteImage(previousPublicId);
    }

    void this.auditService?.log({
      actorUserId: userId,
      action: 'users.avatar.update',
      resource: 'users',
      resourceId: userId,
      outcome: 'ALLOW',
    });

    return {
      id: user.id,
      name: user.name,
      maskedEmail: maskEmail(user.email),
      maskedCpf: user.cpf ? maskCpf(user.cpf) : null,
      maskedPhone: maskPhone(user.phone),
      hasCpf: Boolean(user.cpf),
      avatarUrl: buildProtectedMediaPath(
        'avatar',
        user.id,
        uploaded.url,
        uploaded.publicId,
      ),
    };
  }

  async getDecryptedAvatar(
    viewerUserId: string,
    targetUserId: string,
  ): Promise<DecryptedMediaPayload> {
    if (!targetUserId) {
      throw new NotFoundException('Foto de perfil não encontrada.');
    }

    const targetUser = await this.findById(targetUserId);
    if (!targetUser || !targetUser.avatarUrl) {
      throw new NotFoundException('Foto de perfil não encontrada.');
    }

    if (targetUserId !== viewerUserId) {
      const [viewerUser, viewerMember, targetMember] = await Promise.all([
        this.findById(viewerUserId),
        this.firebase.findById<FamilyMemberDoc>(
          COLLECTIONS.FAMILY_MEMBERS,
          viewerUserId,
        ),
        this.firebase.findById<FamilyMemberDoc>(
          COLLECTIONS.FAMILY_MEMBERS,
          targetUserId,
        ),
      ]);

      const authorizedSameFamily = Boolean(
        viewerUser &&
        viewerUser.cpf &&
        targetUser.cpf &&
        viewerMember &&
        targetMember &&
        viewerMember.userCpf === viewerUser.cpf &&
        targetMember.userCpf === targetUser.cpf &&
        viewerMember.familyGroupId === targetMember.familyGroupId,
      );

      if (!authorizedSameFamily) {
        throw new ForbiddenException(
          'Sem permissão para visualizar a foto deste usuário.',
        );
      }
    }

    if (!this.cloudinaryService) {
      throw new BadRequestException(
        'Serviço de armazenamento de imagens indisponível.',
      );
    }

    return this.cloudinaryService.downloadAndDecryptImage({
      url: targetUser.avatarUrl,
      categoryFolder: 'avatars',
      ownerKey: targetUser.id,
    });
  }

  async removeAvatar(userId: string) {
    const user = await this.findById(userId);
    if (!user || user.isActive === false) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const previousPublicId = user.avatarPublicId || null;

    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      avatarUrl: null,
      avatarPublicId: null,
      updatedAt: new Date().toISOString(),
    });

    if (previousPublicId) {
      await this.cloudinaryService?.deleteImage(previousPublicId);
    }

    void this.auditService?.log({
      actorUserId: userId,
      action: 'users.avatar.delete',
      resource: 'users',
      resourceId: userId,
      outcome: 'ALLOW',
    });

    return {
      id: user.id,
      name: user.name,
      maskedEmail: maskEmail(user.email),
      maskedCpf: user.cpf ? maskCpf(user.cpf) : null,
      maskedPhone: maskPhone(user.phone),
      hasCpf: Boolean(user.cpf),
      avatarUrl: null,
    };
  }

  async revokeUserTokens(userId: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) return;
    await this.firebase.updateDoc(COLLECTIONS.USERS, userId, {
      tokenVersion: (user.tokenVersion ?? 1) + 1,
      updatedAt: new Date().toISOString(),
    });
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
            `Não foi possível sincronizar atualização com Firebase Auth: ${error instanceof Error ? redactSensitiveText(error.message) : 'erro desconhecido'}`,
          );
        }
      }
    }

    void this.auditService?.log({
      actorUserId: user.id,
      action: 'users.profile.update',
      resource: 'users',
      resourceId: user.id,
      outcome: 'ALLOW',
    });

    return updated;
  }

  async exportAccountData(userId: string, requestedCpf?: string) {
    if (!userId) {
      throw new ForbiddenException('Identificador de usuário ausente.');
    }

    const user = await this.findById(userId);
    if (!user || user.id !== userId) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const userCpf = normalizeCpf(user.cpf || '');
    if (!userCpf || !isValidCpf(userCpf)) {
      throw new BadRequestException(
        'Cadastre um CPF válido no seu perfil para baixar o relatório vinculado ao seu CPF + ID.',
      );
    }

    if (requestedCpf && requestedCpf.trim()) {
      const normalizedRequested = normalizeCpf(requestedCpf);
      if (normalizedRequested && normalizedRequested !== userCpf) {
        throw new ForbiddenException(
          'Bloqueio de segurança: o CPF informado não corresponde ao CPF vinculado ao seu ID.',
        );
      }
    }

    const cpfLockId = computeBlindIndex('lock:cpf', userCpf);
    const cpfLock = await this.firebase.findById<{ userId: string }>(
      COLLECTIONS.CPF_LOCKS,
      cpfLockId,
    );
    if (cpfLock && cpfLock.userId && cpfLock.userId !== user.id) {
      throw new ForbiddenException(
        'Bloqueio de segurança: vínculo CPF + ID inválido.',
      );
    }

    const [rawCategories, rawIncomes, rawExpenses, rawInvestments] =
      await Promise.all([
        this.firebase.findByField<AccountTypeDoc>(
          COLLECTIONS.ACCOUNT_TYPES,
          'userId',
          user.id,
        ),
        this.firebase.findByField<IncomeDoc>(COLLECTIONS.INCOME, 'userId', user.id),
        this.firebase.findByField<ExpenseDoc>(
          COLLECTIONS.EXPENSES,
          'userId',
          user.id,
        ),
        this.firebase.findByField<InvestmentDoc>(
          COLLECTIONS.INVESTMENTS,
          'userId',
          user.id,
        ),
      ]);

    // Dupla trava em memória: garante que 100% dos registros pertencem exclusivamente a este user.id
    const categories = rawCategories.filter((c) => c.userId === user.id);
    const incomes = rawIncomes.filter((i) => i.userId === user.id);
    const expenses = rawExpenses.filter((e) => e.userId === user.id);
    const investmentItems = rawInvestments
      .filter((inv) => inv.userId === user.id)
      .sort((a, b) => b.investedDate.localeCompare(a.investedDate))
      .map((inv) => ({
        id: inv.id,
        userId: user.id,
        ownerCpfMasked: maskCpf(userCpf),
        name: inv.name,
        category: inv.category,
        amount: Number(inv.amount || 0),
        investedDate: inv.investedDate,
        source: inv.source,
        notes: inv.notes ?? null,
      }));

    const typesById = new Map(categories.map((c) => [c.id, c]));
    const today = getTodayParts();

    let totalCreditedIncome = 0;
    let totalScheduledIncome = 0;
    const formattedIncomes = incomes.map((inc) => {
      const credit = evaluateIncomeCredit(inc, today);
      totalCreditedIncome += credit.creditedAmount;
      totalScheduledIncome += credit.scheduledAmount;
      return {
        id: inc.id,
        userId: user.id,
        ownerCpfMasked: maskCpf(userCpf),
        name: inc.name,
        value: Number(inc.value || 0),
        incomeDate: inc.incomeDate,
        isRecurring: Boolean(inc.isRecurring),
        creditedAmount: Number(credit.creditedAmount.toFixed(2)),
        scheduledAmount: Number(credit.scheduledAmount.toFixed(2)),
      };
    });

    let totalPaidExpenses = 0;
    let totalCashPaidExpenses = 0;
    let totalFoodVoucherExpenses = 0;
    let totalPendingExpenses = 0;
    const expensesByCategory: Record<string, number> = {};

    const formattedExpenses = expenses.map((exp) => {
      if (exp.paymentMethod === 'credito' && !exp.isCreditCard) {
        return null;
      }
      const val = Number(exp.value || 0);
      const hasParts = Array.isArray(exp.payments) && exp.payments.length > 0;
      const isEarlyDiscount = Boolean(exp.isEarlyPayment) && Boolean(exp.isPaid);
      const paidAmt = hasParts
        ? Math.min(
          val,
          Number(
            exp.payments!
              .reduce((sum, p) => sum + Number(p.amount || 0), 0)
              .toFixed(2),
          ),
        )
        : exp.isPaid
          ? isEarlyDiscount && Number(exp.paidAmount || 0) > 0
            ? Math.min(val, Number(exp.paidAmount))
            : val
          : Math.min(val, Number(exp.paidAmount || 0));
      const remainingAmt = exp.isPaid
        ? 0
        : Math.max(0, Number((val - paidAmt).toFixed(2)));
      const effectiveExpenseAmt =
        isEarlyDiscount && paidAmt > 0 ? paidAmt : val;

      if (hasParts) {
        for (const part of exp.payments!) {
          const partVal = Number(part.amount || 0);
          totalPaidExpenses += partVal;
          if (part.paymentMethod === 'va' || part.paymentMethod === 'vr') {
            totalFoodVoucherExpenses += partVal;
          } else if (part.paymentMethod !== 'credito') {
            totalCashPaidExpenses += partVal;
          }
        }
        totalPendingExpenses += remainingAmt;
      } else if (exp.isPaid || paidAmt > 0) {
        totalPaidExpenses += paidAmt;
        if (exp.paymentMethod === 'va' || exp.paymentMethod === 'vr') {
          totalFoodVoucherExpenses += paidAmt;
        } else if (exp.paymentMethod !== 'credito') {
          totalCashPaidExpenses += paidAmt;
        }
        totalPendingExpenses += remainingAmt;
      } else {
        totalPendingExpenses += val;
      }
      const catName = normalizeOfficialCategory(
        typesById.get(exp.accountTypeId)?.name,
      );
      expensesByCategory[catName] = Number(
        ((expensesByCategory[catName] || 0) + effectiveExpenseAmt).toFixed(2),
      );
      return {
        id: exp.id,
        userId: user.id,
        ownerCpfMasked: maskCpf(userCpf),
        name: exp.name,
        category: catName,
        value: val,
        paidAmount: paidAmt,
        discountAmount: Number(exp.discountAmount || 0),
        isEarlyPayment: isEarlyDiscount,
        remainingAmount: remainingAmt,
        paidAt: exp.paidAt || null,
        payments: exp.payments || [],
        dueDate: exp.dueDate,
        isPaid: Boolean(exp.isPaid),
        paymentMethod: exp.paymentMethod || null,
        pixKey: exp.pixKey ?? null,
        isAutoDebit: Boolean(exp.isAutoDebit),
        cardBank: exp.cardBank ?? null,
        cardLast4: exp.cardLast4 ?? null,
        isRecurring: Boolean(exp.isRecurring),
        isInstallment: Boolean(exp.isInstallment),
        installmentNumber: exp.installmentNumber || null,
        installmentCount: exp.installmentCount || null,
      };
    }).filter(Boolean);

    const allocatedEmergencyFund = Number(user.emergencyFund || 0);
    const externalEmergencyFund = Number(user.externalEmergencyFund || 0);
    const emergencyFund = allocatedEmergencyFund + externalEmergencyFund;
    const allocatedInvestments = Number(user.investments || 0);
    const externalInvestments = Number(user.externalInvestments || 0);
    const investments = allocatedInvestments + externalInvestments;
    const foodAllowanceTotal = Number(user.foodAllowance || 0);
    const foodAllowanceRemaining = Math.max(
      0,
      Number((foodAllowanceTotal - totalFoodVoucherExpenses).toFixed(2)),
    );
    const availableBalance = Number(
      (
        totalCreditedIncome -
        totalCashPaidExpenses -
        allocatedEmergencyFund -
        allocatedInvestments
      ).toFixed(2),
    );

    const ownershipSignature = computeDeterministicHash(
      `export:${user.id}:${userCpf}`,
    );

    void this.auditService?.log({
      actorUserId: user.id,
      action: 'users.data.export',
      resource: 'users',
      resourceId: user.id,
      outcome: 'ALLOW',
    });

    return {
      exportedAt: new Date().toISOString(),
      application: 'Finanças',
      securityVerification: {
        verifiedBy: 'CPF_AND_USER_ID',
        userId: user.id,
        cpf: userCpf,
        maskedCpf: maskCpf(userCpf),
        ownershipSignature,
      },
      profile: {
        id: user.id,
        name: user.name,
        email: user.email,
        cpf: userCpf,
        maskedCpf: maskCpf(userCpf),
        phone: user.phone,
        authProvider: user.authProvider || 'password',
        createdAt: user.createdAt,
      },
      summary: {
        patrimonioDisponivel: availableBalance,
        totalReceitasCreditadas: Number(totalCreditedIncome.toFixed(2)),
        totalReceitasAgendadas: Number(totalScheduledIncome.toFixed(2)),
        totalDespesasPagas: Number(totalPaidExpenses.toFixed(2)),
        totalDespesasPendentes: Number(totalPendingExpenses.toFixed(2)),
        emergencyFund,
        investments,
        valeAlimentacaoRefeicaoTotal: foodAllowanceTotal,
        valeAlimentacaoRefeicaoUsado: Number(totalFoodVoucherExpenses.toFixed(2)),
        valeAlimentacaoRefeicaoSaldo: foodAllowanceRemaining,
        gastosPorCategoria: expensesByCategory,
        totalCategories: categories.length,
        totalIncomes: formattedIncomes.length,
        totalExpenses: formattedExpenses.length,
      },
      categories,
      incomes: formattedIncomes,
      expenses: formattedExpenses,
      investmentsList: investmentItems,
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
      tokenVersion: (user.tokenVersion ?? 1) + 1,
      deactivatedAt: now.toISOString(),
      deactivatedAtMs,
      updatedAt: now.toISOString(),
    });

    void this.auditService?.log({
      actorUserId: user.id,
      action: 'users.account.deactivate',
      resource: 'users',
      resourceId: user.id,
      outcome: 'ALLOW',
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
      expenseReminders,
      biometricCredentials,
      biometricChallenges,
      incomes,
      accountTypes,
      investments,
      memberships,
      sentInvites,
      receivedInvites,
    ] = await Promise.all([
      this.firebase.findByField<ExpenseDoc>(
        COLLECTIONS.EXPENSES,
        'userId',
        userId,
      ),
      this.firebase.findByField<ExpenseReminderDoc>(
        COLLECTIONS.EXPENSE_REMINDERS,
        'userId',
        userId,
      ),
      this.firebase.findByField<BiometricCredentialDoc>(
        COLLECTIONS.BIOMETRIC_CREDENTIALS,
        'userId',
        userId,
      ),
      this.firebase.findByField<BiometricChallengeDoc>(
        COLLECTIONS.BIOMETRIC_CHALLENGES,
        'userId',
        userId,
      ),
      this.firebase.findByField<IncomeDoc>(COLLECTIONS.INCOME, 'userId', userId),
      this.firebase.findByField<AccountTypeDoc>(
        COLLECTIONS.ACCOUNT_TYPES,
        'userId',
        userId,
      ),
      this.firebase.findByField<InvestmentDoc>(
        COLLECTIONS.INVESTMENTS,
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

    const cloudinaryAssetsToRemove = [
      user.avatarPublicId,
      ...expenses.map((doc) => doc.receiptPublicId),
    ].filter((pubId): pubId is string => Boolean(pubId));

    if (this.cloudinaryService && cloudinaryAssetsToRemove.length > 0) {
      await Promise.allSettled(
        cloudinaryAssetsToRemove.map((pubId) =>
          this.cloudinaryService!.deleteImage(pubId),
        ),
      );
    }

    await Promise.all([
      ...expenses.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.EXPENSES, doc.id),
      ),
      ...expenseReminders.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.EXPENSE_REMINDERS, doc.id),
      ),
      ...biometricCredentials.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.BIOMETRIC_CREDENTIALS, doc.id),
      ),
      ...biometricChallenges.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.BIOMETRIC_CHALLENGES, doc.id),
      ),
      ...incomes.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.INCOME, doc.id),
      ),
      ...investments.map((doc) =>
        this.firebase.deleteDoc(COLLECTIONS.INVESTMENTS, doc.id),
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

    await this.auditService?.log({
      actorUserId: computeBlindIndex('audit:deleted', userId).slice(0, 24),
      action: 'users.account.delete',
      resource: 'users',
      outcome: 'ALLOW',
    });

    return {
      message:
        'Conta, dados financeiros e acesso no Firebase excluídos permanentemente.',
    };
  }
}
