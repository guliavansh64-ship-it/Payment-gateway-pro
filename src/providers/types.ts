import type { Merchant } from '../domain/models';
import type { TransactionStatus } from '../domain/status';

/**
 * Provider adapter contract.
 *
 * Adding a provider means implementing this interface and registering it — no
 * other part of the application needs to know the provider exists. Every method
 * a provider cannot genuinely support must be marked unsupported in
 * `capabilities` and must throw `ProviderError(kind: 'unsupported')`, never
 * return a fabricated success.
 */

export type ProviderCapabilities = {
  /** Provider issues a dynamic QR / payment link for an exact amount. */
  dynamicQr: boolean;
  /** Provider supports a server-side payment request creation call. */
  paymentRequest: boolean;
  /** Provider exposes an authorised status API we may poll. */
  statusApi: boolean;
  /** Provider signs webhooks. */
  webhooks: boolean;
  /** Provider exposes a refund API. */
  refunds: boolean;
  /** Provider exposes settlement/reconciliation data. */
  reconciliation: boolean;
  /** Purely local test double; never real money. */
  simulated: boolean;
};

export type CreatePaymentInput = {
  orderId: string;
  amountPaise: number;
  currency: 'INR';
  description: string | null;
  customerReference: string | null;
  merchant: Merchant;
  expiresAt: Date;
};

export type CreatePaymentResult = {
  providerPaymentId: string;
  /** UPI intent URI for a QR code, if the provider returns one. */
  qrPayload: string | null;
  /** Hosted checkout URL, when the provider uses one. */
  checkoutUrl: string | null;
  upiVpa: string | null;
  expiresAt: Date | null;
  raw: Record<string, unknown>;
};

export type ProviderPaymentStatus =
  | 'SUCCESS'
  | 'FAILED'
  | 'PENDING'
  | 'REVERSED'
  | 'REFUNDED'
  | 'UNKNOWN';

export type StatusQuery = {
  providerPaymentId: string;
  orderId: string;
};

export type StatusResult = {
  status: ProviderPaymentStatus;
  providerPaymentId: string;
  /**
   * The bank/UPI reference (UTR/RRN) when the provider exposes one. This is the
   * only identifier that may be used for cross-source matching with a Gmail
   * notification.
   */
  providerTransactionReference: string | null;
  amountPaise: number | null;
  currency: string;
  paidAt: Date | null;
  payeeVpa: string | null;
  failureReason: string | null;
  raw: Record<string, unknown>;
};

export type WebhookVerification = {
  eventId: string;
  eventType: string;
  occurredAt: Date | null;
  signatureScheme: string;
  /** Replay protection assessment; false means the request must be rejected. */
  timestampFresh: boolean;
};

export type NormalizedWebhook = {
  eventId: string;
  eventType: string;
  providerPaymentId: string | null;
  providerOrderReference: string | null;
  providerTransactionReference: string | null;
  amountPaise: number | null;
  currency: string;
  status: ProviderPaymentStatus;
  paidAt: Date | null;
  payeeVpa: string | null;
  failureReason: string | null;
  /** Our own order id, only when the provider echoes it in a metadata field. */
  internalOrderReference: string | null;
  raw: Record<string, unknown>;
};

export type RefundInput = {
  providerPaymentId: string;
  amountPaise: number;
  currency: 'INR';
  reasonNote: string;
  /** Our refund id, sent as the provider idempotency key where supported. */
  internalRefundId: string;
};

export type RefundResult = {
  providerRefundId: string;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  raw: Record<string, unknown>;
};

export type ProviderHealth = {
  status: 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
  detail: string;
};

export interface PaymentProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** Credentials present and structurally usable. */
  isConfigured(): boolean;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  getPaymentStatus(query: StatusQuery): Promise<StatusResult>;
  /**
   * Verifies authenticity using the provider's documented procedure.
   * Throws `WebhookSignatureError` on failure.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookVerification>;
  /** Parses a payload that has already passed signature verification. */
  parseWebhook(payload: Record<string, unknown>): NormalizedWebhook;
  refund(input: RefundInput): Promise<RefundResult>;
  /**
   * Optional: fetch the current state of a refund. Adapters that cannot query
   * refund status must omit this; pending refunds then require a manual check
   * against the provider dashboard (documented limitation).
   */
  getRefundStatus?(input: {
    providerRefundId: string;
    providerPaymentId: string;
  }): Promise<{ status: 'PENDING' | 'PROCESSED' | 'FAILED'; raw: Record<string, unknown> }>;
  checkHealth(): Promise<ProviderHealth>;
}

/** Maps a provider-specific status onto our canonical status. */
export function mapStatus(value: string | undefined | null): ProviderPaymentStatus {
  const s = (value ?? '').toLowerCase();
  switch (s) {
    case 'paid':
    case 'success':
    case 'successful':
    case 'captured':
    case 'charged':
    case 'processed':
    case 'completed':
      return 'SUCCESS';
    case 'failed':
    case 'failure':
    case 'cancelled':
    case 'canceled':
    case 'expired':
    case 'user_dropped':
    case 'terminated':
    case 'declined':
      return 'FAILED';
    case 'pending':
    case 'created':
    case 'authorized':
    case 'partially_paid':
    case 'processing':
    case 'requested':
      return 'PENDING';
    case 'reversed':
    case 'chargeback':
      return 'REVERSED';
    case 'refunded':
      return 'REFUNDED';
    default:
      return 'UNKNOWN';
  }
}

export function isSuccessStatus(status: TransactionStatus): boolean {
  return status === 'SUCCESS';
}
