import type { OrderStatus, TransactionSource, TransactionStatus, VerificationStatus } from '../domain/status';

/** BIGINT columns arrive as strings from node-postgres. Parse strictly. */
export function toSafeInt(value: string | number | null | undefined, field: string): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Column ${field} is not a safe integer: ${value}`);
  return n;
}

export function toSafeIntOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Column is not a safe integer: ${value}`);
  return n;
}

export function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

export function requireDate(value: Date | string | null | undefined, field: string): Date {
  const d = toDate(value);
  if (!d || Number.isNaN(d.getTime())) throw new Error(`Column ${field} is not a valid timestamp`);
  return d;
}

export function asJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return value as T;
}

export type OrderRow = {
  id: string;
  order_id: string;
  merchant_id: string;
  amount_paise: string;
  currency: string;
  payment_method: string;
  provider_name: string;
  provider_payment_id: string | null;
  public_token: string;
  status: string;
  verification_status: string;
  upi_payee_vpa: string | null;
  upi_payee_name: string | null;
  qr_payload: string | null;
  description: string | null;
  customer_reference: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  paid_at: Date | null;
  verification_source: string | null;
  verified_at: Date | null;
  paid_amount_paise: string | null;
  refunded_paise: string;
  metadata: Record<string, unknown>;
};

export function mapOrder(row: OrderRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    merchantId: row.merchant_id,
    amountPaise: toSafeInt(row.amount_paise, 'amount_paise'),
    currency: row.currency,
    paymentMethod: row.payment_method as 'UPI_QR' | 'UPI_ID' | 'UPI_INTENT',
    providerName: row.provider_name,
    providerPaymentId: row.provider_payment_id,
    publicToken: row.public_token,
    status: row.status as OrderStatus,
    verificationStatus: row.verification_status as VerificationStatus,
    upiPayeeVpa: row.upi_payee_vpa,
    upiPayeeName: row.upi_payee_name,
    qrPayload: row.qr_payload,
    description: row.description,
    customerReference: row.customer_reference,
    createdAt: requireDate(row.created_at, 'created_at'),
    updatedAt: requireDate(row.updated_at, 'updated_at'),
    expiresAt: requireDate(row.expires_at, 'expires_at'),
    paidAt: toDate(row.paid_at),
    verificationSource: row.verification_source as TransactionSource | null,
    verifiedAt: toDate(row.verified_at),
    paidAmountPaise: toSafeIntOrNull(row.paid_amount_paise),
    refundedPaise: toSafeInt(row.refunded_paise, 'refunded_paise'),
    metadata: asJson<Record<string, unknown>>(row.metadata, {}),
  };
}

export type TransactionRow = {
  id: string;
  provider_name: string;
  provider_transaction_reference: string;
  provider_payment_id: string | null;
  order_id: string | null;
  merchant_id: string;
  amount_paise: string;
  currency: string;
  transaction_status: string;
  verification_status: string;
  source: string;
  candidate_fingerprint: string | null;
  payee_vpa: string | null;
  payer_reference: string | null;
  transaction_timestamp: Date;
  verified_at: Date | null;
  credited_to_order: boolean;
  raw_evidence: Record<string, unknown>;
  created_at: Date;
};

export function mapTransaction(row: TransactionRow) {
  return {
    id: row.id,
    providerName: row.provider_name,
    providerTransactionReference: row.provider_transaction_reference,
    providerPaymentId: row.provider_payment_id,
    orderPk: row.order_id,
    merchantId: row.merchant_id,
    amountPaise: toSafeInt(row.amount_paise, 'amount_paise'),
    currency: row.currency,
    transactionStatus: row.transaction_status as TransactionStatus,
    verificationStatus: row.verification_status as VerificationStatus,
    source: row.source as TransactionSource,
    candidateFingerprint: row.candidate_fingerprint,
    payeeVpa: row.payee_vpa,
    payerReference: row.payer_reference,
    transactionTimestamp: requireDate(row.transaction_timestamp, 'transaction_timestamp'),
    verifiedAt: toDate(row.verified_at),
    creditedToOrder: row.credited_to_order,
    rawEvidence: asJson<Record<string, unknown>>(row.raw_evidence, {}),
    createdAt: requireDate(row.created_at, 'created_at'),
  };
}

export const ORDER_COLUMNS = `id, order_id, merchant_id, amount_paise, currency, payment_method,
  provider_name, provider_payment_id, public_token, status, verification_status,
  upi_payee_vpa, upi_payee_name, qr_payload, description, customer_reference,
  created_at, updated_at, expires_at, paid_at, verification_source, verified_at,
  paid_amount_paise, refunded_paise, metadata`;

export const TRANSACTION_COLUMNS = `id, provider_name, provider_transaction_reference, provider_payment_id,
  order_id, merchant_id, amount_paise, currency, transaction_status, verification_status, source,
  candidate_fingerprint, payee_vpa, payer_reference, transaction_timestamp, verified_at,
  credited_to_order, raw_evidence, created_at`;
