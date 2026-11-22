import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import {
  buildFamilyInviteEmailHtml,
  buildFamilyInviteEmailSubject,
  buildFamilyInviteEmailText,
} from '../auth/email-template';
import { EmailSenderService } from '../auth/email-sender.service';
import { AuditService } from '../common/audit.service';
import { isValidCpf, maskCpf, maskPhone, normalizeCpf } from '../common/cpf.utils';
import { redactSensitiveText } from '../common/data-crypto.utils';
import { FirebaseService } from '../firebase/firebase.service';
import {
  COLLECTIONS,
  ExpenseDoc,
  FamilyGroupDoc,
  FamilyInviteDoc,
  FamilyMemberDoc,
  FamilyMemberPermissions,
  IncomeDoc,
  InvestmentDoc,
  UserDoc,
} from '../firebase/firebase.types';
import { UpdateFamilyPrivacyDto } from './dto/update-family-privacy.dto';
import { FamilyEventsService } from './family-events.service';

export const FULL_MEMBER_PERMISSIONS: FamilyMemberPermissions = {
  viewBalance: true,
  viewIncome: true,
  viewExpenses: true,
  viewInvestments: true,
  viewEmergencyFund: true,
  viewFoodAllowance: true,
};

export const RESTRICTED_MEMBER_PERMISSIONS: FamilyMemberPermissions = {
  viewBalance: false,
  viewIncome: false,
  viewExpenses: false,
  viewInvestments: false,
  viewEmergencyFund: false,
  viewFoodAllowance: false,
};

export function resolveMemberPermissionsForViewer(
  ownerMember: FamilyMemberDoc | undefined,
  viewerUserId: string,
): FamilyMemberPermissions {
  if (!ownerMember || ownerMember.userId === viewerUserId) {
    return { ...FULL_MEMBER_PERMISSIONS };
  }
  const config = ownerMember.privacyConfig;
  if (!config || config.fullAccessAll) {
    return { ...FULL_MEMBER_PERMISSIONS };
  }
  const specific = config.perMember?.[viewerUserId];
  if (!specific) {
    return { ...RESTRICTED_MEMBER_PERMISSIONS };
  }
  return {
    viewBalance: Boolean(specific.viewBalance),
    viewIncome: Boolean(specific.viewIncome),
    viewExpenses: Boolean(specific.viewExpenses),
    viewInvestments: Boolean(specific.viewInvestments),
    viewEmergencyFund: Boolean(specific.viewEmergencyFund),
    viewFoodAllowance: Boolean(specific.viewFoodAllowance),
  };
}

export interface AuthorizedScope {
  mode: 'individual' | 'family';
  userIds: string[];
  userMap: Map<
    string,
    { id: string; name: string; maskedCpf: string; phone: string | null }
  >;
  memberPermissions?: Map<string, FamilyMemberPermissions>;
  familyGroupId: string | null;
}

@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly eventsService: FamilyEventsService,
    @Optional() private readonly emailSender?: EmailSenderService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async resolveAuthorizedScope(
    userId: string,
    requestedScope?: string,
  ): Promise<AuthorizedScope> {
    const currentUser = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (!currentUser) {
      throw new ForbiddenException('Usuário não autorizado.');
    }

    const individualMap = new Map<
      string,
      { id: string; name: string; maskedCpf: string; phone: string | null }
    >();
    individualMap.set(currentUser.id, {
      id: currentUser.id,
      name: currentUser.name,
      maskedCpf: maskCpf(currentUser.cpf),
      phone: currentUser.phone,
    });

    const memberPermissions = new Map<string, FamilyMemberPermissions>();
    memberPermissions.set(currentUser.id, { ...FULL_MEMBER_PERMISSIONS });

    if (requestedScope !== 'family') {
      return {
        mode: 'individual',
        userIds: [currentUser.id],
        userMap: individualMap,
        memberPermissions,
        familyGroupId: null,
      };
    }

    if (!currentUser.cpf || !isValidCpf(currentUser.cpf)) {
      throw new ForbiddenException(
        'Cadastre um CPF válido no seu perfil para acessar o Painel Família.',
      );
    }

    const membership = await this.firebase.findById<FamilyMemberDoc>(
      COLLECTIONS.FAMILY_MEMBERS,
      currentUser.id,
    );

    if (!membership || membership.userCpf !== currentUser.cpf) {
      throw new ForbiddenException(
        'Você não possui vínculo ativo validado por CPF neste Painel Família.',
      );
    }

    const allMembers = await this.firebase.findByField<FamilyMemberDoc>(
      COLLECTIONS.FAMILY_MEMBERS,
      'familyGroupId',
      membership.familyGroupId,
    );

    const memberUsers = await this.firebase.findByFieldIn<UserDoc>(
      COLLECTIONS.USERS,
      'id',
      allMembers.map((m) => m.userId),
    );
    const usersById = new Map(memberUsers.map((u) => [u.id, u]));

    const verifiedUserIds: string[] = [];
    const userMap = new Map<
      string,
      { id: string; name: string; maskedCpf: string; phone: string | null }
    >();

    for (const member of allMembers) {
      const user = usersById.get(member.userId);
      if (
        user &&
        user.id === member.userId &&
        user.cpf &&
        user.cpf === member.userCpf
      ) {
        const perms = resolveMemberPermissionsForViewer(member, currentUser.id);
        const allowFullContact =
          user.id === currentUser.id || Object.values(perms).every(Boolean);
        verifiedUserIds.push(user.id);
        userMap.set(user.id, {
          id: user.id,
          name: user.name,
          maskedCpf: maskCpf(user.cpf),
          phone: allowFullContact ? user.phone : null,
        });
        memberPermissions.set(user.id, perms);
      }
    }

    if (!verifiedUserIds.includes(currentUser.id)) {
      throw new ForbiddenException('Falha na validação de segurança CPF + ID.');
    }

    return {
      mode: 'family',
      userIds: verifiedUserIds,
      userMap,
      memberPermissions,
      familyGroupId: membership.familyGroupId,
    };
  }

  async notifyFamilyDataChanged(
    actorUserId: string,
    type: 'data_updated' | 'invite_received' | 'family_changed' = 'data_updated',
  ): Promise<void> {
    try {
      const membership = await this.firebase.findById<FamilyMemberDoc>(
        COLLECTIONS.FAMILY_MEMBERS,
        actorUserId,
      );

      if (!membership) {
        this.eventsService.emitToUsers([actorUserId], type);
        return;
      }

      const members = await this.firebase.findByField<FamilyMemberDoc>(
        COLLECTIONS.FAMILY_MEMBERS,
        'familyGroupId',
        membership.familyGroupId,
      );
      this.eventsService.emitToUsers(
        members.map((m) => m.userId),
        type,
      );
    } catch (error) {
      this.logger.warn(
        `Falha ao emitir atualização em tempo real do Modo Família: ${
          error instanceof Error
            ? redactSensitiveText(error.message)
            : 'erro inesperado'
        }`,
      );
    }
  }

  async getStatus(userId: string) {
    const currentUser = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (!currentUser) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const rawMembership = currentUser.cpf
      ? await this.firebase.findById<FamilyMemberDoc>(
          COLLECTIONS.FAMILY_MEMBERS,
          currentUser.id,
        )
      : null;
    const membership =
      rawMembership && rawMembership.userCpf === currentUser.cpf
        ? rawMembership
        : null;

    let group: FamilyGroupDoc | null = null;
    let members: Array<{
      userId: string;
      name: string;
      maskedCpf: string;
      maskedPhone: string | null;
      phone: string | null;
      avatarUrl: string | null;
      role: 'owner' | 'member';
      isSelf: boolean;
      permissionsSharedWithMe: FamilyMemberPermissions;
    }> = [];

    if (membership) {
      const [groupDoc, groupMembers] = await Promise.all([
        this.firebase.findById<FamilyGroupDoc>(
          COLLECTIONS.FAMILY_GROUPS,
          membership.familyGroupId,
        ),
        this.firebase.findByField<FamilyMemberDoc>(
          COLLECTIONS.FAMILY_MEMBERS,
          'familyGroupId',
          membership.familyGroupId,
        ),
      ]);
      group = groupDoc;

      const memberUsers = await this.firebase.findByFieldIn<UserDoc>(
        COLLECTIONS.USERS,
        'id',
        groupMembers.map((m) => m.userId),
      );
      const usersById = new Map(memberUsers.map((u) => [u.id, u]));

      members = groupMembers
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((m) => ({ m, user: usersById.get(m.userId) }))
        .filter(({ m, user }) => user && user.cpf === m.userCpf)
        .map(({ m, user }) => {
          const isSelf = user!.id === currentUser.id;
          const perms = resolveMemberPermissionsForViewer(m, currentUser.id);
          const allowFullContact =
            isSelf || Object.values(perms).every(Boolean);
          return {
            userId: user!.id,
            name: user!.name,
            maskedCpf: maskCpf(user!.cpf),
            maskedPhone: maskPhone(user!.phone),
            phone: allowFullContact ? user!.phone : null,
            avatarUrl: user!.avatarUrl || null,
            role: m.role,
            isSelf,
            permissionsSharedWithMe: perms,
          };
        });
    }

    const [allReceived, allSent] = await Promise.all([
      currentUser.cpf
        ? this.firebase.findByField<FamilyInviteDoc>(
            COLLECTIONS.FAMILY_INVITES,
            'inviteeUserId',
            currentUser.id,
          )
        : Promise.resolve([]),
      this.firebase.findByField<FamilyInviteDoc>(
        COLLECTIONS.FAMILY_INVITES,
        'inviterUserId',
        currentUser.id,
      ),
    ]);

    const pendingReceivedRaw = allReceived
      .filter(
        (inv) =>
          inv.status === 'pending' && inv.inviteeCpf === currentUser.cpf,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const pendingSentRaw = allSent
      .filter((inv) => inv.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const relatedUserIds = [
      ...pendingReceivedRaw.map((inv) => inv.inviterUserId),
      ...pendingSentRaw.map((inv) => inv.inviteeUserId),
    ];
    const relatedGroupIds = pendingReceivedRaw.map((inv) => inv.familyGroupId);

    const [relatedUsers, relatedGroups] = await Promise.all([
      this.firebase.findByFieldIn<UserDoc>(
        COLLECTIONS.USERS,
        'id',
        relatedUserIds,
      ),
      this.firebase.findByFieldIn<FamilyGroupDoc>(
        COLLECTIONS.FAMILY_GROUPS,
        'id',
        relatedGroupIds,
      ),
    ]);

    const usersById = new Map(relatedUsers.map((u) => [u.id, u]));
    const groupsById = new Map(relatedGroups.map((g) => [g.id, g]));

    return {
      hasCpf: Boolean(currentUser.cpf && isValidCpf(currentUser.cpf)),
      maskedCpf: currentUser.cpf ? maskCpf(currentUser.cpf) : null,
      inFamily: members.length >= 2,
      hasGroup: Boolean(membership),
      group: group ? { id: group.id, name: group.name } : null,
      members,
      myPrivacy: {
        fullAccessAll: membership?.privacyConfig?.fullAccessAll ?? true,
        rules: members
          .filter((m) => !m.isSelf)
          .map((m) => ({
            targetUserId: m.userId,
            ...resolveMemberPermissionsForViewer(
              membership ?? undefined,
              m.userId,
            ),
          })),
      },
      pendingReceivedInvites: pendingReceivedRaw
        .map((inv) => ({ inv, inviter: usersById.get(inv.inviterUserId) }))
        .filter(({ inv, inviter }) => inviter && inviter.cpf === inv.inviterCpf)
        .map(({ inv, inviter }) => ({
          id: inv.id,
          inviterName: inviter!.name,
          inviterMaskedCpf: maskCpf(inv.inviterCpf),
          inviterPhone: maskPhone(inviter!.phone),
          groupName:
            groupsById.get(inv.familyGroupId)?.name || 'Painel Família',
          createdAt: inv.createdAt,
        })),
      pendingSentInvites: pendingSentRaw.map((inv) => ({
        id: inv.id,
        inviteeName: usersById.get(inv.inviteeUserId)?.name || 'Usuário',
        inviteeMaskedCpf: maskCpf(inv.inviteeCpf),
        status: inv.status,
        createdAt: inv.createdAt,
      })),
    };
  }

  async getSyncVersion(userId: string) {
    const currentUser = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (!currentUser) {
      throw new ForbiddenException('Usuário não autorizado.');
    }

    let userIds = [currentUser.id];
    let groupId = 'none';
    let membersCount = 0;
    let privacyStamp = 'none';

    if (currentUser.cpf) {
      const membership = await this.firebase.findById<FamilyMemberDoc>(
        COLLECTIONS.FAMILY_MEMBERS,
        currentUser.id,
      );
      if (membership && membership.userCpf === currentUser.cpf) {
        groupId = membership.familyGroupId;
        const members = await this.firebase.findByField<FamilyMemberDoc>(
          COLLECTIONS.FAMILY_MEMBERS,
          'familyGroupId',
          membership.familyGroupId,
        );
        userIds = members.map((m) => m.userId);
        membersCount = members.length;
        privacyStamp = members
          .map((m) => `${m.userId}:${m.updatedAt || ''}`)
          .sort()
          .join('|');
      }
    }

    const [expenses, incomes, users, investmentItems, receivedInvites] =
      await Promise.all([
        this.firebase.findByFieldIn<ExpenseDoc>(
          COLLECTIONS.EXPENSES,
          'userId',
          userIds,
        ),
        this.firebase.findByFieldIn<IncomeDoc>(
          COLLECTIONS.INCOME,
          'userId',
          userIds,
        ),
        this.firebase.findByFieldIn<UserDoc>(COLLECTIONS.USERS, 'id', userIds),
        this.firebase.findByFieldIn<InvestmentDoc>(
          COLLECTIONS.INVESTMENTS,
          'userId',
          userIds,
        ),
        currentUser.cpf
          ? this.firebase.findByField<FamilyInviteDoc>(
              COLLECTIONS.FAMILY_INVITES,
              'inviteeUserId',
              currentUser.id,
            )
          : Promise.resolve([]),
      ]);

    const pendingInvitesCount = receivedInvites.filter(
      (inv) => inv.status === 'pending' && inv.inviteeCpf === currentUser.cpf,
    ).length;

    const expPaidCount = expenses.filter((e) => e.isPaid).length;
    const expSum = expenses.reduce((acc, e) => acc + Number(e.value || 0), 0);
    const expMax = expenses.reduce(
      (max, e) => Math.max(max, new Date(e.updatedAt || 0).getTime()),
      0,
    );
    const incSum = incomes.reduce((acc, i) => acc + Number(i.value || 0), 0);
    const incMax = incomes.reduce(
      (max, i) => Math.max(max, new Date(i.updatedAt || 0).getTime()),
      0,
    );
    const userMax = users.reduce(
      (max, u) => Math.max(max, new Date(u.updatedAt || 0).getTime()),
      0,
    );
    const invItemMax = investmentItems.reduce(
      (max, it) => Math.max(max, new Date(it.updatedAt || 0).getTime()),
      0,
    );
    const reserveSum = users.reduce(
      (acc, u) =>
        acc + Number(u.emergencyFund || 0) + Number(u.externalEmergencyFund || 0),
      0,
    );
    const invSum = users.reduce(
      (acc, u) =>
        acc + Number(u.investments || 0) + Number(u.externalInvestments || 0),
      0,
    );
    const foodSum = users.reduce(
      (acc, u) => acc + Number(u.foodAllowance || 0),
      0,
    );

    const version = [
      groupId,
      membersCount,
      pendingInvitesCount,
      expenses.length,
      expPaidCount,
      expSum.toFixed(2),
      expMax,
      incomes.length,
      incSum.toFixed(2),
      incMax,
      userMax,
      investmentItems.length,
      invItemMax,
      reserveSum.toFixed(2),
      invSum.toFixed(2),
      foodSum.toFixed(2),
      privacyStamp,
    ].join(':');

    return {
      version,
      pendingInvitesCount,
      membersCount,
      inFamily: membersCount >= 2,
    };
  }

  async inviteByCpf(inviterUserId: string, rawCpf: string) {
    const normalizedTargetCpf = normalizeCpf(rawCpf);
    if (!isValidCpf(normalizedTargetCpf)) {
      throw new BadRequestException(
        'CPF inválido. Informe um CPF válido com 11 dígitos.',
      );
    }

    const inviter = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      inviterUserId,
    );
    if (!inviter) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    if (!inviter.cpf || !isValidCpf(inviter.cpf)) {
      throw new BadRequestException(
        'Cadastre seu próprio CPF em "Editar Perfil" antes de convidar alguém para o Modo Família.',
      );
    }

    if (inviter.cpf === normalizedTargetCpf) {
      throw new BadRequestException(
        'Você não pode enviar um convite para o seu próprio CPF.',
      );
    }

    const invitee = await this.firebase.findOneByField<UserDoc>(
      COLLECTIONS.USERS,
      'cpf',
      normalizedTargetCpf,
    );

    if (!invitee) {
      throw new NotFoundException(
        'Nenhum usuário encontrado com este CPF. Peça para a pessoa cadastrar o CPF no perfil dela.',
      );
    }

    const [inviteeMembership, rawInviterMembership] = await Promise.all([
      this.firebase.findById<FamilyMemberDoc>(
        COLLECTIONS.FAMILY_MEMBERS,
        invitee.id,
      ),
      this.firebase.findById<FamilyMemberDoc>(
        COLLECTIONS.FAMILY_MEMBERS,
        inviter.id,
      ),
    ]);

    let inviterMembership =
      rawInviterMembership && rawInviterMembership.userCpf === inviter.cpf
        ? rawInviterMembership
        : null;

    if (
      inviteeMembership &&
      inviterMembership &&
      inviteeMembership.familyGroupId === inviterMembership.familyGroupId
    ) {
      throw new ConflictException(
        'Esta pessoa já faz parte do seu Painel Família.',
      );
    }

    if (inviteeMembership) {
      throw new ConflictException(
        'Este usuário já está vinculado a outro Painel Família.',
      );
    }

    const now = new Date().toISOString();

    if (!inviterMembership) {
      const group: FamilyGroupDoc = {
        id: uuidv4(),
        name: `Família de ${inviter.name.split(' ')[0]}`,
        createdByUserId: inviter.id,
        createdAt: now,
        updatedAt: now,
      };
      await this.firebase.setDoc(COLLECTIONS.FAMILY_GROUPS, group);

      inviterMembership = {
        id: inviter.id,
        familyGroupId: group.id,
        userId: inviter.id,
        userCpf: inviter.cpf,
        role: 'owner',
        createdAt: now,
        updatedAt: now,
      };
      await this.firebase.setDoc(COLLECTIONS.FAMILY_MEMBERS, inviterMembership);
    }

    const groupInvites = await this.firebase.findByField<FamilyInviteDoc>(
      COLLECTIONS.FAMILY_INVITES,
      'familyGroupId',
      inviterMembership.familyGroupId,
    );
    const existingInvite = groupInvites.find(
      (i) => i.inviteeUserId === invitee.id && i.status === 'pending',
    );

    if (existingInvite) {
      throw new ConflictException(
        'Já existe um convite pendente aguardando confirmação deste usuário.',
      );
    }

    const invite: FamilyInviteDoc = {
      id: uuidv4(),
      familyGroupId: inviterMembership.familyGroupId,
      inviterUserId: inviter.id,
      inviterCpf: inviter.cpf,
      inviteeUserId: invitee.id,
      inviteeCpf: normalizedTargetCpf,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await this.firebase.setDoc(COLLECTIONS.FAMILY_INVITES, invite);

    this.eventsService.emitToUsers([invitee.id, inviter.id], 'invite_received');

    let emailSent = false;
    if (this.emailSender && invitee.email) {
      try {
        const frontendBase = (
          process.env.FRONTEND_URL?.split(',')[0] ||
          'https://painel-monet-front.vercel.app'
        )
          .trim()
          .replace(/\/+$/, '');
        const actionUrl = `${frontendBase}/dashboard`;
        const logoUrl = `${frontendBase}/logo192.png?v=5`;
        const groupName = `Família de ${inviter.name.split(' ')[0]}`;
        const maskedInviterCpf = maskCpf(inviter.cpf);

        const emailRes = await this.emailSender.sendHtmlEmail({
          toEmail: invitee.email,
          toName: invitee.name,
          subject: buildFamilyInviteEmailSubject(inviter.name),
          html: buildFamilyInviteEmailHtml({
            inviteeName: invitee.name,
            inviterName: inviter.name,
            inviterMaskedCpf: maskedInviterCpf,
            groupName,
            actionUrl,
            logoUrl,
          }),
          text: buildFamilyInviteEmailText({
            inviteeName: invitee.name,
            inviterName: inviter.name,
            inviterMaskedCpf: maskedInviterCpf,
            groupName,
            actionUrl,
            logoUrl,
          }),
        });
        emailSent = emailRes.sent;
      } catch (err) {
        this.logger.warn(
          `Não foi possível enviar e-mail de notificação de convite família: ${
            err instanceof Error ? redactSensitiveText(err.message) : 'erro desconhecido'
          }`,
        );
      }
    }

    void this.auditService?.log({
      actorUserId: inviter.id,
      action: 'family.invite.send',
      resource: 'family_invites',
      resourceId: invite.id,
      outcome: 'ALLOW',
    });

    return {
      id: invite.id,
      inviteeName: invitee.name,
      inviteeMaskedCpf: maskCpf(invitee.cpf),
      emailSent,
      message: `Convite enviado para ${invitee.name}. Notificação disparada e aguardando confirmação dupla.`,
    };
  }

  async acceptInvite(userId: string, inviteId: string, confirmed: boolean) {
    if (!confirmed) {
      throw new BadRequestException(
        'É necessária a segunda confirmação explícita para unificar o painel.',
      );
    }

    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (!user || !user.cpf || !isValidCpf(user.cpf)) {
      throw new ForbiddenException(
        'Seu CPF precisa estar válido e cadastrado para aceitar o convite.',
      );
    }

    const invite = await this.firebase.findById<FamilyInviteDoc>(
      COLLECTIONS.FAMILY_INVITES,
      inviteId,
    );

    if (
      !invite ||
      invite.inviteeUserId !== user.id ||
      invite.inviteeCpf !== user.cpf ||
      invite.status !== 'pending'
    ) {
      throw new NotFoundException(
        'Convite não encontrado, já respondido ou CPF incompatível.',
      );
    }

    const existingMembership = await this.firebase.findById<FamilyMemberDoc>(
      COLLECTIONS.FAMILY_MEMBERS,
      user.id,
    );
    if (existingMembership) {
      throw new ConflictException(
        'Você já está em um Painel Família. Saia do atual antes de aceitar outro convite.',
      );
    }

    const now = new Date().toISOString();
    const member: FamilyMemberDoc = {
      id: user.id,
      familyGroupId: invite.familyGroupId,
      userId: user.id,
      userCpf: user.cpf,
      role: 'member',
      createdAt: now,
      updatedAt: now,
    };

    await this.firebase.setDoc(COLLECTIONS.FAMILY_MEMBERS, member);
    await this.firebase.updateDoc(COLLECTIONS.FAMILY_INVITES, invite.id, {
      status: 'accepted',
      updatedAt: now,
    });

    await this.notifyFamilyDataChanged(user.id, 'family_changed');

    return {
      message: 'Painel Família unificado com sucesso!',
      familyGroupId: invite.familyGroupId,
    };
  }

  async rejectInvite(userId: string, inviteId: string) {
    const user = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (!user || !user.cpf) {
      throw new ForbiddenException('Usuário não autorizado.');
    }

    const invite = await this.firebase.findById<FamilyInviteDoc>(
      COLLECTIONS.FAMILY_INVITES,
      inviteId,
    );

    if (
      !invite ||
      invite.inviteeUserId !== user.id ||
      invite.inviteeCpf !== user.cpf ||
      invite.status !== 'pending'
    ) {
      throw new NotFoundException('Convite não encontrado.');
    }

    await this.firebase.updateDoc(COLLECTIONS.FAMILY_INVITES, invite.id, {
      status: 'rejected',
      updatedAt: new Date().toISOString(),
    });

    this.eventsService.emitToUsers(
      [invite.inviterUserId, user.id],
      'family_changed',
    );

    return { message: 'Convite recusado.' };
  }

  async cancelInvite(userId: string, inviteId: string) {
    const invite = await this.firebase.findById<FamilyInviteDoc>(
      COLLECTIONS.FAMILY_INVITES,
      inviteId,
    );

    if (
      !invite ||
      invite.inviterUserId !== userId ||
      invite.status !== 'pending'
    ) {
      throw new NotFoundException('Convite pendente não encontrado.');
    }

    await this.firebase.updateDoc(COLLECTIONS.FAMILY_INVITES, invite.id, {
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });

    this.eventsService.emitToUsers(
      [invite.inviteeUserId, userId],
      'family_changed',
    );

    return { message: 'Convite cancelado.' };
  }

  async updatePrivacy(userId: string, dto: UpdateFamilyPrivacyDto) {
    const currentUser = await this.firebase.findById<UserDoc>(
      COLLECTIONS.USERS,
      userId,
    );
    if (!currentUser || !currentUser.cpf || !isValidCpf(currentUser.cpf)) {
      throw new ForbiddenException('Usuário não autorizado.');
    }

    const membership = await this.firebase.findById<FamilyMemberDoc>(
      COLLECTIONS.FAMILY_MEMBERS,
      userId,
    );
    if (!membership || membership.userCpf !== currentUser.cpf) {
      throw new ForbiddenException(
        'Você não participa de um Painel Família ativo.',
      );
    }

    const allMembers = await this.firebase.findByField<FamilyMemberDoc>(
      COLLECTIONS.FAMILY_MEMBERS,
      'familyGroupId',
      membership.familyGroupId,
    );
    const validTargetIds = new Set(
      allMembers.map((m) => m.userId).filter((id) => id !== userId),
    );

    const perMember: Record<string, FamilyMemberPermissions> = {};
    for (const rule of dto.rules || []) {
      if (validTargetIds.has(rule.targetUserId)) {
        perMember[rule.targetUserId] = {
          viewBalance: Boolean(rule.viewBalance),
          viewIncome: Boolean(rule.viewIncome),
          viewExpenses: Boolean(rule.viewExpenses),
          viewInvestments: Boolean(rule.viewInvestments),
          viewEmergencyFund: Boolean(rule.viewEmergencyFund),
          viewFoodAllowance: Boolean(rule.viewFoodAllowance),
        };
      }
    }

    await this.firebase.updateDoc(COLLECTIONS.FAMILY_MEMBERS, membership.id, {
      privacyConfig: {
        fullAccessAll: Boolean(dto.fullAccessAll),
        perMember,
      },
      updatedAt: new Date().toISOString(),
    });

    await this.notifyFamilyDataChanged(userId, 'data_updated');
    await this.notifyFamilyDataChanged(userId, 'family_changed');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'family.privacy.update',
      resource: 'family_members',
      resourceId: membership.id,
      outcome: 'ALLOW',
      details: `fullAccessAll=${Boolean(dto.fullAccessAll)}`,
    });

    return this.getStatus(userId);
  }

  async leaveFamily(userId: string) {
    const membership = await this.firebase.findById<FamilyMemberDoc>(
      COLLECTIONS.FAMILY_MEMBERS,
      userId,
    );

    if (!membership) {
      throw new NotFoundException(
        'Você não participa de nenhum Painel Família.',
      );
    }

    const groupId = membership.familyGroupId;
    const allMembers = await this.firebase.findByField<FamilyMemberDoc>(
      COLLECTIONS.FAMILY_MEMBERS,
      'familyGroupId',
      groupId,
    );
    const notifyIds = allMembers.map((m) => m.userId);

    await this.firebase.deleteDoc(COLLECTIONS.FAMILY_MEMBERS, userId);

    const remaining = allMembers.filter((m) => m.userId !== userId);
    if (remaining.length === 0) {
      await this.firebase.deleteDoc(COLLECTIONS.FAMILY_GROUPS, groupId);
    }

    this.eventsService.emitToUsers(notifyIds, 'family_changed');

    void this.auditService?.log({
      actorUserId: userId,
      action: 'family.leave',
      resource: 'family_members',
      resourceId: groupId,
      outcome: 'ALLOW',
    });

    return {
      message:
        'Você saiu do Modo Família. Seus dados voltaram a ser exclusivos.',
    };
  }
}
