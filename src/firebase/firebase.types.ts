export interface FoodMonthlyOverride {
  amount?: number;
  creditDate?: string;
  skipped?: boolean;
}

export interface FoodBenefitConfig {
  enabled: boolean;
  amount: number;
  creditDate: string;
  isRecurring: boolean;
  mode: 'fixed' | 'variable';
  recurrenceEndMonth?: string | null;
  monthlyOverrides?: Record<string, FoodMonthlyOverride>;
}

export interface YieldHistoryEntry {
  id: string;
  month: string;
  previousAmount: number;
  newAmount: number;
  delta: number;
  date: string;
  note?: string | null;
}

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
  emergencyFundTotalYield?: number;
  emergencyFundYieldHistory?: YieldHistoryEntry[];
  investments: number;
  externalInvestments?: number;
  foodAllowance?: number;
  foodAllowanceDate?: string | null;
  foodAllowanceRecurring?: boolean;
  vaConfig?: FoodBenefitConfig | null;
  vrConfig?: FoodBenefitConfig | null;
  createdAt: string;
  updatedAt: string;
  securityPinHash?: string | null;
  securityPinVersion?: number;
  securityPinUpdatedAt?: string | null;
  securityPinFailedAttempts?: number;
  securityPinLockedUntilMs?: number | null;
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

export interface ExpenseMonthlyOverride {
  value?: number;
  name?: string;
  day?: number;
  accountTypeId?: string;
  skipped?: boolean;
  materializedExpenseId?: string;
}

export interface IncomeMonthlyOverride {
  value?: number;
  name?: string;
  day?: number;
  skipped?: boolean;
}

export interface ExpenseDoc {
  id: string;
  userId: string;
  accountTypeId: string;
  name: string;
  value: number;
  dueDate: string;
  isRecurring: boolean;
  recurrenceEndMonth?: string | null;
  recurrenceGroupId?: string | null;
  recurrenceParentId?: string | null;
  occurrenceMonth?: string | null;
  monthlyOverrides?: Record<string, ExpenseMonthlyOverride>;
  isInstallment: boolean;
  installmentCount: number | null;
  installmentNumber: number | null;
  parentExpenseId: string | null;
  sourceExpenseId?: string | null;
  isPaid: boolean;
  paidAmount?: number;
  discountAmount?: number;
  isEarlyPayment?: boolean;
  paidAt?: string | null;
  payments?: ExpensePaymentPart[];
  isCreditCard: boolean;
  paymentMethod: string | null;
  pixKey?: string | null;
  isAutoDebit?: boolean;
  cardBank?: string | null;
  cardLast4?: string | null;
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
  recurrenceEndMonth?: string | null;
  recurrenceGroupId?: string | null;
  monthlyOverrides?: Record<string, IncomeMonthlyOverride>;
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
  principalAmount?: number;
  allocatedPrincipal?: number;
  yieldAmount?: number;
  lastYieldUpdateAt?: string | null;
  yieldHistory?: YieldHistoryEntry[];
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

export type ExpenseReminderKind = 'due_tomorrow' | 'due_today';

export interface ExpenseReminderDoc {
  id: string;
  userId: string;
  expenseId: string;
  dueDate: string;
  kind: ExpenseReminderKind;
  emailSentAt: string | null;
  deviceNotifiedAt: string | null;
  createdAt: string;
  expiresAtMs: number;
}

export type BiometricKind = 'facial' | 'fingerprint' | 'biometric';
export type BiometricPlatform = 'web' | 'pwa' | 'mobile_ios' | 'mobile_android';
export type BiometricProtocol = 'webauthn' | 'native_hmac';

export interface BiometricCredentialDoc {
  id: string;
  userId: string;
  credentialId: string;
  protocol: BiometricProtocol;
  kind: BiometricKind;
  platform: BiometricPlatform;
  deviceLabel: string;
  publicKeySpkiPem?: string | null;
  nativeSecretHex?: string | null;
  signCount: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

export interface BiometricChallengeDoc {
  id: string;
  nonce: string;
  purpose: 'register' | 'login';
  userId?: string | null;
  credentialId?: string | null;
  pendingSecretHex?: string | null;
  protocol: BiometricProtocol;
  kind: BiometricKind;
  createdAt: string;
  expiresAtMs: number;
  consumed: boolean;
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
  EXPENSE_REMINDERS: 'expense_reminders',
  BIOMETRIC_CREDENTIALS: 'biometric_credentials',
  BIOMETRIC_CHALLENGES: 'biometric_challenges',
  INCOME: 'income',
  INVESTMENTS: 'investments',
  FAMILY_GROUPS: 'family_groups',
  FAMILY_MEMBERS: 'family_members',
  FAMILY_INVITES: 'family_invites',
  AUDIT_LOGS: 'audit_logs',
  RATE_LIMITS: 'rate_limits',
} as const;
