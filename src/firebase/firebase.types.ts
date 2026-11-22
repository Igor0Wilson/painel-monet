export interface UserDoc {
  id: string;
  name: string;
  email: string;
  cpf: string | null;
  phone: string | null;
  avatarUrl?: string | null;
  avatarPublicId?: string | null;
  firebaseUid: string | null;
  authProvider: 'password' | 'google';
  isActive: boolean;
  tokenVersion?: number;
  emailIndex?: string | null;
  cpfIndex?: string | null;
  encryptionKeyVersion?: string;
  deactivatedAt: string | null;
  deactivatedAtMs: number | null;
  emergencyFund: number;
  externalEmergencyFund?: number;
  investments: number;
  externalInvestments?: number;
  foodAllowance?: number;
  foodAllowanceDate?: string | null;
  foodAllowanceRecurring?: boolean;
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

export type ExpensePaymentMethod =
  | 'dinheiro'
  | 'pix'
  | 'debito'
  | 'credito'
  | 'va'
  | 'vr';

export interface ExpensePaymentPart {
  id: string;
  amount: number;
  paidAt: string;
  paymentMethod: ExpensePaymentMethod;
  createdAt?: string;
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
  sourceExpenseId?: string | null;
  isPaid: boolean;
  paidAmount?: number;
  paidAt?: string | null;
  payments?: ExpensePaymentPart[];
  isCreditCard: boolean;
  paymentMethod: string | null;
  receiptUrl?: string | null;
  receiptPublicId?: string | null;
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

export type InvestmentSource = 'external' | 'balance';

export interface InvestmentDoc {
  id: string;
  userId: string;
  name: string;
  category: string;
  amount: number;
  investedDate: string;
  source: InvestmentSource;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FamilyMemberPermissions {
  viewBalance: boolean;
  viewIncome: boolean;
  viewExpenses: boolean;
  viewInvestments: boolean;
  viewEmergencyFund: boolean;
  viewFoodAllowance: boolean;
}

export interface FamilyPrivacyConfig {
  fullAccessAll: boolean;
  perMember: Record<string, FamilyMemberPermissions>;
}

export interface FamilyMemberDoc {
  id: string;
  familyGroupId: string;
  userId: string;
  userCpf: string;
  role: 'owner' | 'member';
  privacyConfig?: FamilyPrivacyConfig;
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

export interface AuditLogDoc {
  id: string;
  actorUserId: string;
  action: string;
  resource: string;
  resourceId: string | null;
  outcome: 'ALLOW' | 'DENY' | 'ERROR';
  httpMethod?: string | null;
  path?: string | null;
  statusCode?: number | null;
  ipHash?: string | null;
  details?: string | null;
  createdAt: string;
  expiresAtMs: number;
}

export interface RateLimitDoc {
  id: string;
  totalHits: number;
  expiresAtMs: number;
  blockedUntilMs: number;
  updatedAtMs: number;
}

export const COLLECTIONS = {
  USERS: 'users',
  CPF_LOCKS: 'cpf_locks',
  EMAIL_LOCKS: 'email_locks',
  ACCOUNT_TYPES: 'account_types',
  EXPENSES: 'expenses',
  INCOME: 'income',
  INVESTMENTS: 'investments',
  FAMILY_GROUPS: 'family_groups',
  FAMILY_MEMBERS: 'family_members',
  FAMILY_INVITES: 'family_invites',
  AUDIT_LOGS: 'audit_logs',
  RATE_LIMITS: 'rate_limits',
} as const;
