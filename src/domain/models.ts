import type {
  OrderStatus,
  TransactionSource,
  TransactionStatus,
  VerificationStatus,
} from './status';

/**
 * Domain models. These are deliberately separate from database rows: the DB
 * uses snake_case and returns BIGINT as strings, both of which must not leak
 * into business logic.
 */

export type UserRole = 'USER' | 'MERCHANT_ADMIN' | 'ADMIN' | 'AUDITOR';

export type User = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  failedLogins: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
};

export type Merchant = {
  id: string;
  ownerId: string;
  merchantCode: string;
  businessName: string;
  verifiedMerchantUpiId: string | null;
  upiVerifiedAt: Date | null;
  providerAccountId: string | null;
  accountStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  latePaymentPolicy: 'FULFIL' | 'REFUND' | 'REVIEW';
  defaultProvider: string | null;
  brandingColor: string;
  supportEmail: string | null;
  createdAt: Date;
};

export type PaymentMethod = 'UPI_QR' | 'UPI_ID' | 'UPI_INTENT';

export type Order = {
  id: string;
  orderId: string;
  merchantId: string;
  amountPaise: number;
  currency: string;
  paymentMethod: PaymentMethod;
  providerName: string;
  providerPaymentId: string | null;
  publicToken: string;
  status: OrderStatus;
  verificationStatus: VerificationStatus;
  upiPayeeVpa: string | null;
  upiPayeeName: string | null;
  qrPayload: string | null;
  description: string | null;
  customerReference: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  paidAt: Date | null;
  verificationSource: TransactionSource | null;
  verifiedAt: Date | null;
  paidAmountPaise: number | null;
  refundedPaise: number;
  metadata: Record<string, unknown>;
};

export type PaymentTransaction = {
  id: string;
  providerName: string;
  providerTransactionReference: string;
  providerPaymentId: string | null;
  orderPk: string | null;
  merchantId: string;
  amountPaise: number;
  currency: string;
  transactionStatus: TransactionStatus;
  verificationStatus: VerificationStatus;
  source: TransactionSource;
  candidateFingerprint: string | null;
  payeeVpa: string | null;
  payerReference: string | null;
  transactionTimestamp: Date;
  verifiedAt: Date | null;
  creditedToOrder: boolean;
  rawEvidence: Record<string, unknown>;
  createdAt: Date;
};

export type PaymentEvent = {
  id: string;
  eventId: string;
  orderPk: string | null;
  paymentOrderRef: string | null;
  eventType: string;
  source: TransactionSource;
  sourceReference: string | null;
  eventPayloadHash: string;
  payload: Record<string, unknown>;
  processingStatus: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'DUPLICATE' | 'FAILED' | 'IGNORED';
  processingAttempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  receivedAt: Date;
  processedAt: Date | null;
};

export type GmailConnection = {
  id: string;
  userId: string;
  merchantId: string | null;
  providerEmail: string;
  encryptedRefreshToken: string;
  tokenKeyVersion: string;
  grantedScopes: string[];
  connectionStatus: 'CONNECTED' | 'DEGRADED' | 'REVOKED' | 'ERROR';
  lastSyncAt: Date | null;
  lastError: string | null;
  historyCursor: string | null;
  lastMessageAt: Date | null;
  watchExpiresAt: Date | null;
  consecutiveFailures: number;
  createdAt: Date;
};

export type ReconciliationReason =
  | 'AMBIGUOUS_MATCH'
  | 'MISSING_REFERENCE'
  | 'AMOUNT_MISMATCH'
  | 'WRONG_MERCHANT'
  | 'DUPLICATE_PAYMENT'
  | 'LATE_PAYMENT'
  | 'TRANSACTION_REVERSED'
  | 'PROVIDER_UNAVAILABLE'
  | 'GMAIL_UNVERIFIED'
  | 'WEBHOOK_UNVERIFIABLE'
  | 'OTHER';

export type ReconciliationCase = {
  id: string;
  merchantId: string;
  candidateTransactionId: string | null;
  orderPk: string | null;
  possibleOrderIds: string[];
  reason: ReconciliationReason;
  detail: string | null;
  resolutionStatus: 'OPEN' | 'RESOLVED_PAID' | 'RESOLVED_REJECTED' | 'RESOLVED_REFUNDED' | 'ESCALATED';
  resolutionNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
};

export type Refund = {
  id: string;
  orderPk: string;
  transactionId: string | null;
  providerName: string;
  providerRefundId: string | null;
  amountPaise: number;
  status: 'REQUESTED' | 'PENDING' | 'PROCESSED' | 'FAILED' | 'CANCELLED';
  reasonCode: 'DUPLICATE' | 'FRAUDULENT' | 'REQUESTED_BY_CUSTOMER' | 'LATE_PAYMENT' | 'AMOUNT_MISMATCH' | 'OTHER';
  reasonNote: string | null;
  requestedBy: string | null;
  requestedAt: Date;
  processedAt: Date | null;
};

export type AuditLog = {
  id: string;
  actorId: string | null;
  actorType: 'SYSTEM' | 'USER' | 'ADMIN' | 'PROVIDER' | 'CUSTOMER';
  action: string;
  resourceType: string;
  resourceId: string | null;
  sanitizedMetadata: Record<string, unknown>;
  createdAt: Date;
};

export type ProviderConfig = {
  providerName: string;
  enabled: boolean;
  mode: string;
  publicConfig: Record<string, unknown>;
  secretRef: string | null;
  lastHealthAt: Date | null;
  lastHealthStatus: 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN' | null;
  lastHealthDetail: string | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  csrfTokenHash: string;
  elevatedUntil: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgentHash: string | null;
  ipHash: string | null;
};
