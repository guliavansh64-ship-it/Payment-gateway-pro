import type { PoolClient } from 'pg';
import { one, query } from '../db/pool';
import type { PaymentEvent, PaymentTransaction } from '../domain/models';
import type { TransactionSource, TransactionStatus, VerificationStatus } from '../domain/status';
import { TRANSACTION_COLUMNS, mapTransaction, type TransactionRow } from './mappers';

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

export async function findTransactionByProviderReference(
  providerName: string,
  reference: string,
): Promise<PaymentTransaction | null> {
  const row = await one<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM payment_transactions
      WHERE provider_name = $1 AND provider_transaction_reference = $2`,
    [providerName, reference],
  );
  return row ? mapTransaction(row) : null;
}

export async function findTransactionsByOrder(orderPk: string): Promise<PaymentTransaction[]> {
  const res = await query<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM payment_transactions
      WHERE order_id = $1 ORDER BY created_at ASC`,
    [orderPk],
  );
  return res.rows.map(mapTransaction);
}

export async function findTransactionsByProviderPaymentId(
  providerName: string,
  providerPaymentId: string,
): Promise<PaymentTransaction[]> {
  const res = await query<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM payment_transactions
      WHERE provider_name = $1 AND (provider_payment_id = $2 OR provider_transaction_reference = $2)`,
    [providerName, providerPaymentId],
  );
  return res.rows.map(mapTransaction);
}

export async function insertTransaction(
  client: PoolClient,
  input: {
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
  },
): Promise<PaymentTransaction> {
  const res = await client.query<TransactionRow>(
    `INSERT INTO payment_transactions (provider_name, provider_transaction_reference, provider_payment_id,
        order_id, merchant_id, amount_paise, currency, transaction_status, verification_status, source,
        candidate_fingerprint, payee_vpa, payer_reference, transaction_timestamp, verified_at,
        credited_to_order, raw_evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${TRANSACTION_COLUMNS}`,
    [
      input.providerName,
      input.providerTransactionReference,
      input.providerPaymentId,
      input.orderPk,
      input.merchantId,
      input.amountPaise,
      input.currency,
      input.transactionStatus,
      input.verificationStatus,
      input.source,
      input.candidateFingerprint,
      input.payeeVpa,
      input.payerReference,
      input.transactionTimestamp,
      input.verifiedAt,
      input.creditedToOrder,
      JSON.stringify(input.rawEvidence),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Failed to insert transaction');
  return mapTransaction(row);
}

export type TransactionPatch = Partial<{
  orderPk: string | null;
  transactionStatus: TransactionStatus;
  verificationStatus: VerificationStatus;
  source: TransactionSource;
  verifiedAt: Date | null;
  creditedToOrder: boolean;
  rawEvidence: Record<string, unknown>;
  providerPaymentId: string | null;
  payeeVpa: string | null;
}>;

const TX_UPDATABLE: Record<keyof TransactionPatch, string> = {
  orderPk: 'order_id',
  transactionStatus: 'transaction_status',
  verificationStatus: 'verification_status',
  source: 'source',
  verifiedAt: 'verified_at',
  creditedToOrder: 'credited_to_order',
  rawEvidence: 'raw_evidence',
  providerPaymentId: 'provider_payment_id',
  payeeVpa: 'payee_vpa',
};

export async function updateTransaction(
  client: PoolClient,
  id: string,
  patch: TransactionPatch,
): Promise<PaymentTransaction> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(TX_UPDATABLE)) {
    const value = patch[key as keyof TransactionPatch];
    if (value === undefined) continue;
    params.push(key === 'rawEvidence' ? JSON.stringify(value) : value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) throw new Error('Empty transaction patch');
  params.push(id);
  const res = await client.query<TransactionRow>(
    `UPDATE payment_transactions SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING ${TRANSACTION_COLUMNS}`,
    params,
  );
  const row = res.rows[0];
  if (!row) throw new Error('Transaction not found');
  return mapTransaction(row);
}

export type TransactionListFilters = {
  merchantId?: string;
  verificationStatus?: VerificationStatus;
  source?: TransactionSource;
  search?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

export async function listTransactions(
  filters: TransactionListFilters,
): Promise<{ rows: Array<PaymentTransaction & { orderId: string | null }>; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (filters.merchantId) add('t.merchant_id = ?', filters.merchantId);
  if (filters.verificationStatus) add('t.verification_status = ?', filters.verificationStatus);
  if (filters.source) add('t.source = ?', filters.source);
  if (filters.from) add('t.created_at >= ?', filters.from);
  if (filters.to) add('t.created_at <= ?', filters.to);
  if (filters.search) {
    params.push(`%${filters.search.trim()}%`);
    const i = params.length;
    clauses.push(
      `(t.provider_transaction_reference ILIKE $${i} OR t.provider_payment_id ILIKE $${i}
        OR o.order_id ILIKE $${i})`,
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const totalRow = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM payment_transactions t
       LEFT JOIN payment_orders o ON o.id = t.order_id ${where}`,
    params,
  );
  const res = await query<TransactionRow & { order_ref: string | null }>(
    `SELECT ${TRANSACTION_COLUMNS.split(',').map((c) => `t.${c.trim()}`).join(', ')}, o.order_id AS order_ref
       FROM payment_transactions t
       LEFT JOIN payment_orders o ON o.id = t.order_id
       ${where}
       ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    rows: res.rows.map((r) => ({ ...mapTransaction(r), orderId: r.order_ref })),
    total: Number(totalRow?.count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// events (idempotent inbox)
// ---------------------------------------------------------------------------

export async function recordEvent(
  input: {
    eventId: string;
    orderPk: string | null;
    paymentOrderRef: string | null;
    eventType: string;
    source: TransactionSource;
    sourceReference: string | null;
    eventPayloadHash: string;
    payload: Record<string, unknown>;
  },
): Promise<{ event: PaymentEvent; inserted: boolean }> {
  const res = await query<{
    id: string;
    event_id: string;
    order_id: string | null;
    payment_order_ref: string | null;
    event_type: string;
    source: string;
    source_reference: string | null;
    event_payload_hash: string;
    payload: Record<string, unknown>;
    processing_status: PaymentEvent['processingStatus'];
    processing_attempts: number;
    next_attempt_at: Date | null;
    last_error: string | null;
    received_at: Date;
    processed_at: Date | null;
  }>(
    `INSERT INTO payment_events (event_id, order_id, payment_order_ref, event_type, source,
        source_reference, event_payload_hash, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id, event_id, order_id, payment_order_ref, event_type, source, source_reference,
               event_payload_hash, payload, processing_status, processing_attempts, next_attempt_at,
               last_error, received_at, processed_at`,
    [
      input.eventId,
      input.orderPk,
      input.paymentOrderRef,
      input.eventType,
      input.source,
      input.sourceReference,
      input.eventPayloadHash,
      JSON.stringify(input.payload),
    ],
  );
  const inserted = res.rows[0];
  if (inserted) {
    return {
      inserted: true,
      event: {
        id: inserted.id,
        eventId: inserted.event_id,
        orderPk: inserted.order_id,
        paymentOrderRef: inserted.payment_order_ref,
        eventType: inserted.event_type,
        source: inserted.source as TransactionSource,
        sourceReference: inserted.source_reference,
        eventPayloadHash: inserted.event_payload_hash,
        payload: inserted.payload,
        processingStatus: inserted.processing_status,
        processingAttempts: inserted.processing_attempts,
        nextAttemptAt: inserted.next_attempt_at,
        lastError: inserted.last_error,
        receivedAt: inserted.received_at,
        processedAt: inserted.processed_at,
      },
    };
  }
  const existing = await findEventById(input.eventId);
  if (!existing) throw new Error('Event conflict but no row found');
  return { inserted: false, event: existing };
}

export async function findEventById(eventId: string): Promise<PaymentEvent | null> {
  const row = await one<{
    id: string;
    event_id: string;
    order_id: string | null;
    payment_order_ref: string | null;
    event_type: string;
    source: string;
    source_reference: string | null;
    event_payload_hash: string;
    payload: Record<string, unknown>;
    processing_status: PaymentEvent['processingStatus'];
    processing_attempts: number;
    next_attempt_at: Date | null;
    last_error: string | null;
    received_at: Date;
    processed_at: Date | null;
  }>(
    `SELECT id, event_id, order_id, payment_order_ref, event_type, source, source_reference,
            event_payload_hash, payload, processing_status, processing_attempts, next_attempt_at,
            last_error, received_at, processed_at
       FROM payment_events WHERE event_id = $1`,
    [eventId],
  );
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    orderPk: row.order_id,
    paymentOrderRef: row.payment_order_ref,
    eventType: row.event_type,
    source: row.source as TransactionSource,
    sourceReference: row.source_reference,
    eventPayloadHash: row.event_payload_hash,
    payload: row.payload,
    processingStatus: row.processing_status,
    processingAttempts: row.processing_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

export async function markEventProcessing(eventId: string): Promise<void> {
  await query(
    `UPDATE payment_events SET processing_status = 'PROCESSING', processing_attempts = processing_attempts + 1
      WHERE event_id = $1`,
    [eventId],
  );
}

export async function markEventProcessed(eventId: string, status: 'PROCESSED' | 'DUPLICATE' | 'IGNORED'): Promise<void> {
  await query(
    `UPDATE payment_events SET processing_status = $2, processed_at = now(), last_error = NULL
      WHERE event_id = $1`,
    [eventId, status],
  );
}

export async function markEventFailed(eventId: string, error: string, retryInSeconds: number): Promise<void> {
  await query(
    `UPDATE payment_events
        SET processing_status = 'FAILED', last_error = $2,
            next_attempt_at = now() + ($3 || ' seconds')::interval
      WHERE event_id = $1`,
    [eventId, error.slice(0, 1000), retryInSeconds],
  );
}

export async function findRetryableEvents(limit = 25): Promise<PaymentEvent[]> {
  const res = await query<{
    event_id: string;
    id: string;
    processing_attempts: number;
  }>(
    `SELECT id, event_id, processing_attempts FROM payment_events
      WHERE processing_status = 'FAILED'
        AND processing_attempts < 8
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY next_attempt_at NULLS FIRST LIMIT $1`,
    [limit],
  );
  const events: PaymentEvent[] = [];
  for (const row of res.rows) {
    const ev = await findEventById(row.event_id);
    if (ev) events.push(ev);
  }
  return events;
}

export async function listEventsForOrder(orderPk: string): Promise<PaymentEvent[]> {
  const res = await query<{
    event_id: string;
    source: string;
    event_type: string;
    processing_status: string;
    received_at: Date;
    processed_at: Date | null;
    last_error: string | null;
  }>(
    `SELECT event_id, source, event_type, processing_status, received_at, processed_at, last_error
       FROM payment_events WHERE order_id = $1 ORDER BY received_at DESC LIMIT 50`,
    [orderPk],
  );
  return res.rows.map((r) => ({
    id: r.event_id,
    eventId: r.event_id,
    orderPk,
    paymentOrderRef: null,
    eventType: r.event_type,
    source: r.source as TransactionSource,
    sourceReference: null,
    eventPayloadHash: '',
    payload: {},
    processingStatus: r.processing_status as PaymentEvent['processingStatus'],
    processingAttempts: 0,
    nextAttemptAt: null,
    lastError: r.last_error,
    receivedAt: r.received_at,
    processedAt: r.processed_at,
  }));
}

/**
 * Looks up a transaction by bank/UPI reference across all providers.
 * Gmail alerts never carry our provider name, so corroboration must search
 * every provider. Verified rows win over unverified ones.
 */
export async function findTransactionByReferenceAnyProvider(
  reference: string,
): Promise<PaymentTransaction | null> {
  const row = await one<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM payment_transactions
      WHERE provider_transaction_reference = $1
      ORDER BY (verification_status = 'VERIFIED') DESC, created_at DESC
      LIMIT 1`,
    [reference],
  );
  return row ? mapTransaction(row) : null;
}

export async function findTransactionById(id: string): Promise<PaymentTransaction | null> {
  const row = await one<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM payment_transactions WHERE id = $1`,
    [id],
  );
  return row ? mapTransaction(row) : null;
}

export async function findCreditedTransactionForOrder(
  orderPk: string,
): Promise<PaymentTransaction | null> {
  const row = await one<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM payment_transactions WHERE order_id = $1 AND credited_to_order`,
    [orderPk],
  );
  return row ? mapTransaction(row) : null;
}
