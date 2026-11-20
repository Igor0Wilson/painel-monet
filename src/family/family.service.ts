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
import { isValidCpf, maskCpf, normalizeCpf } from '../common/cpf.utils';
import { FirebaseService } from '../firebase/firebase.service';
import {
  COLLECTIONS,
  ExpenseDoc,
  FamilyGroupDoc,
  FamilyInviteDoc,
  FamilyMemberDoc,
  IncomeDoc,
  UserDoc,
} from '../firebase/firebase.types';
import { FamilyEventsService } from './family-events.service';

export interface AuthorizedScope {
  mode: 'individual' | 'family';
  userIds: string[];
  userMap: Map<
    string,
    { id: string; name: string; maskedCpf: string; phone: string | null }
  >;
  familyGroupId: string | null;
}

@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly eventsService: FamilyEventsService,
    @Optional() private readonly emailSender?: EmailSenderService,
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

    if (requestedScope !== 'family') {
      return {
        mode: 'individual',
        userIds: [currentUser.id],
        userMap: individualMap,
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
        verifiedUserIds.push(user.id);
        userMap.set(user.id, {
          id: user.id,
          name: user.name,
          maskedCpf: maskCpf(user.cpf),
          phone: user.phone,
        });
      }
    }

    if (!verifiedUserIds.includes(currentUser.id)) {
      throw new ForbiddenException('Falha na validação de segurança CPF + ID.');
    }

    return {
      mode: 'family',
      userIds: verifiedUserIds,
      userMap,
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
        `Falha ao emitir atualização em tempo real para o usuário ${actorUserId}: ${
          error instanceof Error ? error.message : String(error)
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
    let members: any[] = [];

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
        .map(({ m, user }) => ({
          userId: user!.id,
          name: user!.name,
          maskedCpf: maskCpf(user!.cpf),
          phone: user!.phone,
          role: m.role,
          isSelf: user!.id === currentUser.id,
        }));
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
      pendingReceivedInvites: pendingReceivedRaw
        .map((inv) => ({ inv, inviter: usersById.get(inv.inviterUserId) }))
        .filter(({ inv, inviter }) => inviter && inviter.cpf === inv.inviterCpf)
        .map(({ inv, inviter }) => ({
          id: inv.id,
          inviterName: inviter!.name,
          inviterMaskedCpf: maskCpf(inv.inviterCpf),
          inviterPhone: inviter!.phone,
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
      }
    }

    const [expenses, incomes, users, receivedInvites] = await Promise.all([
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
    const reserveSum = users.reduce(
      (acc, u) => acc + Number(u.emergencyFund || 0),
      0,
    );
    const invSum = users.reduce(
      (acc, u) => acc + Number(u.investments || 0),
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
      reserveSum.toFixed(2),
      invSum.toFixed(2),
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
        const logoUrl = `${frontendBase}/logo192.png?v=4`;
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
          `Não foi possível enviar e-mail de notificação de convite família para ${invitee.email}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

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

    return {
      message:
        'Você saiu do Modo Família. Seus dados voltaram a ser exclusivos.',
    };
  }
}
