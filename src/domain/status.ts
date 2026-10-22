/**
 * Payment order state machine.
 *
 * The table below is the *only* place that decides whether a transition is
 * legal. Every status write goes through `assertTransition` (see
 * services/orders.ts), which is wrapped in a DB transaction with a row lock.
 */

export const ORDER_STATUSES = [
  'CREATED',
  'PENDING',
  'VERIFYING',
  'PAID',
  'FAILED',
  'EXPIRED',
  'REVIEW_REQUIRED',
  'LATE_PAYMENT',
  'REFUND_PENDING',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  'PAID',
  'FAILED',
  'EXPIRED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
];

/** Statuses in which money is (or may be) held and reconciliation must continue. */
export const MONEY_AT_REST_STATUSES: readonly OrderStatus[] = [
  'PAID',
  'LATE_PAYMENT',
  'PARTIALLY_REFUNDED',
  'REFUND_PENDING',
];

/** Statuses that still accept a first confirmed payment. */
export const AWAITING_PAYMENT_STATUSES: readonly OrderStatus[] = [
  'CREATED',
  'PENDING',
  'VERIFYING',
  'REVIEW_REQUIRED',
  'EXPIRED',
];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // Created is transient: attaching instructions moves the order to PENDING.
  CREATED: ['PENDING', 'FAILED', 'EXPIRED'],
  // A confirmed payment may arrive after the deadline but before the expiry
  // sweeper has run, so PENDING can move straight to LATE_PAYMENT.
  PENDING: ['VERIFYING', 'PAID', 'FAILED', 'EXPIRED', 'REVIEW_REQUIRED', 'LATE_PAYMENT'],
  // A candidate transaction was detected; authoritative verification pending.
  // It may resolve to PAID, back to PENDING (evidence disproved), FAILED,
  // EXPIRED if the window lapsed meanwhile, or REVIEW_REQUIRED on conflict.
  VERIFYING: ['PAID', 'PENDING', 'FAILED', 'EXPIRED', 'REVIEW_REQUIRED', 'LATE_PAYMENT'],
  // A confirmed payment landed after the payment window closed.
  LATE_PAYMENT: ['PAID', 'REFUND_PENDING', 'REVIEW_REQUIRED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  PAID: ['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVIEW_REQUIRED'],
  FAILED: ['REVIEW_REQUIRED'], // manual recovery only, never automatic re-open
  EXPIRED: ['VERIFYING', 'PAID', 'LATE_PAYMENT', 'REVIEW_REQUIRED', 'REFUND_PENDING', 'REFUNDED'],
  REVIEW_REQUIRED: [
    'PAID',
    'PENDING',
    'VERIFYING',
    'EXPIRED',
    'FAILED',
    'LATE_PAYMENT',
    'REFUND_PENDING',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
  ],
  REFUND_PENDING: ['REFUNDED', 'PARTIALLY_REFUNDED', 'PAID', 'REVIEW_REQUIRED'],
  REFUNDED: ['REVIEW_REQUIRED'],
  PARTIALLY_REFUNDED: ['REFUND_PENDING', 'REFUNDED', 'REVIEW_REQUIRED'],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Illegal payment order transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Human-facing labels for the customer and merchant UIs. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  CREATED: 'Created',
  PENDING: 'Awaiting payment',
  VERIFYING: 'Verifying payment',
  PAID: 'Paid',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  REVIEW_REQUIRED: 'Under review',
  LATE_PAYMENT: 'Paid late — under review',
  REFUND_PENDING: 'Refund in progress',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partially refunded',
};

export const STATUS_TONES: Record<OrderStatus, 'success' | 'warn' | 'danger' | 'neutral' | 'info'> =
  {
    CREATED: 'neutral',
    PENDING: 'warn',
    VERIFYING: 'info',
    PAID: 'success',
    FAILED: 'danger',
    EXPIRED: 'neutral',
    REVIEW_REQUIRED: 'danger',
    LATE_PAYMENT: 'warn',
    REFUND_PENDING: 'info',
    REFUNDED: 'neutral',
    PARTIALLY_REFUNDED: 'neutral',
  };

export const VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'PENDING_AUTHORITATIVE',
  'VERIFIED',
  /** Confirmed by an operator against a bank statement / provider dashboard. */
  'MANUALLY_VERIFIED',
  'VERIFICATION_FAILED',
  'REVIEW_REQUIRED',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const TRANSACTION_STATUSES = [
  'SUCCESS',
  'FAILED',
  'PENDING',
  'REVERSED',
  'REFUNDED',
  'UNKNOWN',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TRANSACTION_SOURCES = [
  'PROVIDER_WEBHOOK',
  'PROVIDER_API',
  'RECONCILIATION',
  'GMAIL_NOTIFICATION',
  'MANUAL_ENTRY',
  'SANDBOX',
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

/** Sources allowed to mark an order PAID without a second confirmation call. */
export const AUTHORITATIVE_SOURCES: readonly TransactionSource[] = [
  'PROVIDER_WEBHOOK',
  'PROVIDER_API',
  'RECONCILIATION',
];

/** Sources that can only ever produce a candidate, never a confirmation. */
export const NON_AUTHORITATIVE_SOURCES: readonly TransactionSource[] = [
  'GMAIL_NOTIFICATION',
  'MANUAL_ENTRY',
  'SANDBOX',
];
