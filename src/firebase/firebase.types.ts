export interface UserDoc {
  id: string;
  name: string;
  email: string;
  password: string;
  cpf: string | null;
  phone: string | null;
  emergencyFund: number;
  investments: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountTypeDoc {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseDoc {
  id: string;
  userId: string;
  accountTypeId: string;
  name: string;
  value: number;
  dueDate: string;
  isRecurring: boolean;
  isInstallment: boolean;
  installmentCount: number | null;
  installmentNumber: number | null;
  parentExpenseId: string | null;
  isPaid: boolean;
  isCreditCard: boolean;
  paymentMethod: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncomeDoc {
  id: string;
  userId: string;
  name: string;
  value: number;
  isRecurring: boolean;
  incomeDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface FamilyGroupDoc {
  id: string;
  name: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface FamilyMemberDoc {
  id: string;
  familyGroupId: string;
  userId: string;
  userCpf: string;
  role: 'owner' | 'member';
  createdAt: string;
  updatedAt: string;
}

export interface FamilyInviteDoc {
  id: string;
  familyGroupId: string;
  inviterUserId: string;
  inviterCpf: string;
  inviteeUserId: string;
  inviteeCpf: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export const COLLECTIONS = {
  USERS: 'users',
  ACCOUNT_TYPES: 'account_types',
  EXPENSES: 'expenses',
  INCOME: 'income',
  FAMILY_GROUPS: 'family_groups',
  FAMILY_MEMBERS: 'family_members',
  FAMILY_INVITES: 'family_invites',
} as const;
