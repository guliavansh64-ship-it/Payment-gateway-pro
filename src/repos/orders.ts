import type { PoolClient } from 'pg';
import { one, query } from '../db/pool';
import type { Order, PaymentMethod } from '../domain/models';
import type { OrderStatus, TransactionSource, VerificationStatus } from '../domain/status';
import { ORDER_COLUMNS, mapOrder, type OrderRow } from './mappers';

export type OrderListFilters = {
  merchantId?: string;
  status?: OrderStatus[];
  search?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

function buildFilters(filters: OrderListFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (filters.merchantId) add('o.merchant_id = ?', filters.merchantId);
  if (filters.status && filters.status.length > 0) {
    params.push(filters.status);
    clauses.push(`o.status = ANY($${params.length}::text[])`);
  }
  if (filters.from) add('o.created_at >= ?', filters.from);
  if (filters.to) add('o.created_at <= ?', filters.to);
  if (filters.search) {
    // Search order id, provider payment id and provider transaction reference.
    params.push(`%${filters.search.trim()}%`);
    const idx = params.length;
    clauses.push(
      `(o.order_id ILIKE $${idx} OR o.provider_payment_id ILIKE $${idx}
        OR EXISTS (SELECT 1 FROM payment_transactions t
                    WHERE t.order_id = o.id
                      AND (t.provider_transaction_reference ILIKE $${idx} OR t.provider_payment_id ILIKE $${idx})))`,
    );
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function findOrderByOrderId(orderId: string): Promise<Order | null> {
  const row = await one<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM payment_orders o WHERE o.order_id = $1`, [
    orderId,
  ]);
  return row ? mapOrder(row) : null;
}

export async function findOrderByPk(id: string): Promise<Order | null> {
  const row = await one<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM payment_orders o WHERE o.id = $1`, [id]);
  return row ? mapOrder(row) : null;
}

export async function findOrderByPublicToken(token: string): Promise<Order | null> {
  const row = await one<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM payment_orders o WHERE o.public_token = $1`,
    [token],
  );
  return row ? mapOrder(row) : null;
}

/** Row lock for the whole duration of a status change transaction. */
export async function lockOrderForUpdate(client: PoolClient, orderPk: string): Promise<Order | null> {
  const res = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM payment_orders o WHERE o.id = $1 FOR UPDATE`,
    [orderPk],
  );
  return res.rows[0] ? mapOrder(res.rows[0]) : null;
}

export async function lockOrderByOrderId(
  client: PoolClient,
  orderId: string,
): Promise<Order | null> {
  const res = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM payment_orders o WHERE o.order_id = $1 FOR UPDATE`,
    [orderId],
  );
  return res.rows[0] ? mapOrder(res.rows[0]) : null;
}

export async function insertOrder(
  client: PoolClient,
  input: {
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
    expiresAt: Date;
    metadata: Record<string, unknown>;
  },
): Promise<Order> {
  const res = await client.query<OrderRow>(
    `INSERT INTO payment_orders (order_id, merchant_id, amount_paise, currency, payment_method,
        provider_name, provider_payment_id, public_token, status, verification_status,
        upi_payee_vpa, upi_payee_name, qr_payload, description, customer_reference, expires_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${ORDER_COLUMNS}`,
    [
      input.orderId,
      input.merchantId,
      input.amountPaise,
      input.currency,
      input.paymentMethod,
      input.providerName,
      input.providerPaymentId,
      input.publicToken,
      input.status,
      input.verificationStatus,
      input.upiPayeeVpa,
      input.upiPayeeName,
      input.qrPayload,
      input.description,
      input.customerReference,
      input.expiresAt,
      JSON.stringify(input.metadata),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Failed to insert order');
  return mapOrder(row);
}

/** Column allow-list for updates. Prevents SQL injection via dynamic patching. */
const UPDATABLE = {
  status: 'status',
  verificationStatus: 'verification_status',
  verificationSource: 'verification_source',
  verifiedAt: 'verified_at',
  paidAt: 'paid_at',
  paidAmountPaise: 'paid_amount_paise',
  providerPaymentId: 'provider_payment_id',
  metadata: 'metadata',
  refundedPaise: 'refunded_paise',
  expiresNotifiedAt: 'expires_notified_at',
  qrPayload: 'qr_payload',
} as const;

export type OrderPatch = Partial<{
  status: OrderStatus;
  verificationStatus: VerificationStatus;
  verificationSource: TransactionSource | null;
  verifiedAt: Date | null;
  paidAt: Date | null;
  paidAmountPaise: number | null;
  providerPaymentId: string | null;
  metadata: Record<string, unknown>;
  refundedPaise: number;
  expiresNotifiedAt: Date | null;
  qrPayload: string | null;
}>;

export async function updateOrder(
  client: PoolClient,
  orderPk: string,
  patch: OrderPatch,
): Promise<Order> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    const value = patch[key as keyof OrderPatch];
    if (value === undefined) continue;
    params.push(key === 'metadata' ? JSON.stringify(value) : value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) {
    const current = await lockOrderForUpdate(client, orderPk);
    if (!current) throw new Error('Order not found');
    return current;
  }
  params.push(orderPk);
  const res = await client.query<OrderRow>(
    `UPDATE payment_orders SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${ORDER_COLUMNS}`,
    params,
  );
  const row = res.rows[0];
  if (!row) throw new Error('Order not found while updating');
  return mapOrder(row);
}

export async function insertStatusHistory(
  client: PoolClient,
  input: {
    orderPk: string;
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    reasonCode: string;
    actorType: 'SYSTEM' | 'PROVIDER' | 'USER' | 'ADMIN';
    actorId?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO order_status_history (order_pk, from_status, to_status, reason_code, actor_type, actor_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.orderPk,
      input.fromStatus,
      input.toStatus,
      input.reasonCode,
      input.actorType,
      input.actorId ?? null,
      input.note ?? null,
    ],
  );
}

export async function listOrders(filters: OrderListFilters): Promise<{ rows: Order[]; total: number }> {
  const { where, params } = buildFilters(filters);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const totalRow = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM payment_orders o ${where}`,
    params,
  );
  const res = await query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM payment_orders o ${where}
      ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { rows: res.rows.map(mapOrder), total: Number(totalRow?.count ?? 0) };
}

export type MerchantStats = {
  totalOrders: number;
  confirmedPaid: number;
  pending: number;
  failed: number;
  expired: number;
  reviewRequired: number;
  latePayments: number;
  confirmedValuePaise: number;
  refundedValuePaise: number;
};

export async function merchantStats(merchantId: string, from?: Date, to?: Date): Promise<MerchantStats> {
  const params: unknown[] = [merchantId];
  let range = '';
  if (from) {
    params.push(from);
    range += ` AND created_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    range += ` AND created_at <= $${params.length}`;
  }
  const row = await one<Record<string, string>>(
    `SELECT
       count(*)::text AS total_orders,
       count(*) FILTER (WHERE status = 'PAID')::text AS confirmed_paid,
       count(*) FILTER (WHERE status IN ('CREATED','PENDING','VERIFYING'))::text AS pending,
       count(*) FILTER (WHERE status = 'FAILED')::text AS failed,
       count(*) FILTER (WHERE status = 'EXPIRED')::text AS expired,
       count(*) FILTER (WHERE status = 'REVIEW_REQUIRED')::text AS review_required,
       count(*) FILTER (WHERE status = 'LATE_PAYMENT')::text AS late_payments,
       COALESCE(sum(paid_amount_paise) FILTER (WHERE status IN ('PAID','LATE_PAYMENT','PARTIALLY_REFUNDED','REFUND_PENDING')), 0)::text AS confirmed_value,
       COALESCE(sum(refunded_paise), 0)::text AS refunded_value
     FROM payment_orders WHERE merchant_id = $1 ${range}`,
    params,
  );
  return {
    totalOrders: Number(row?.total_orders ?? 0),
    confirmedPaid: Number(row?.confirmed_paid ?? 0),
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0),
    expired: Number(row?.expired ?? 0),
    reviewRequired: Number(row?.review_required ?? 0),
    latePayments: Number(row?.late_payments ?? 0),
    confirmedValuePaise: Number(row?.confirmed_value ?? 0),
    refundedValuePaise: Number(row?.refunded_value ?? 0),
  };
}

/**
 * Candidate orders for heuristic matching.
 * Bounded by merchant, currency, amount and a time window: never a full scan.
 */
export async function findMatchingCandidates(input: {
  merchantId: string;
  amountPaise: number;
  currency: string;
  windowStart: Date;
  windowEnd: Date;
  statuses: readonly OrderStatus[];
}): Promise<Order[]> {
  const res = await query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM payment_orders o
      WHERE o.merchant_id = $1
        AND o.amount_paise = $2
        AND o.currency = $3
        AND o.status = ANY($4::text[])
        AND o.created_at BETWEEN $5 AND $6
      ORDER BY o.created_at DESC`,
    [input.merchantId, input.amountPaise, input.currency, input.statuses, input.windowStart, input.windowEnd],
  );
  return res.rows.map(mapOrder);
}

export async function findOrdersByProviderPaymentId(
  providerName: string,
  providerPaymentId: string,
): Promise<Order[]> {
  const res = await query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM payment_orders o WHERE o.provider_name = $1 AND o.provider_payment_id = $2`,
    [providerName, providerPaymentId],
  );
  return res.rows.map(mapOrder);
}

/** Orders whose payment window has elapsed but which are not final yet. */
export async function findExpiredCandidates(limit = 100): Promise<Order[]> {
  const res = await query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM payment_orders o
      WHERE o.expires_at < now()
        AND o.status IN ('CREATED','PENDING','VERIFYING')
      ORDER BY o.expires_at ASC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map(mapOrder);
}

/** Orders that still need an authoritative status poll from a provider. */
export async function findOrdersForReconciliation(limit = 50): Promise<Order[]> {
  const res = await query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM payment_orders o
      WHERE o.provider_name <> 'manual_upi'
        AND o.provider_payment_id IS NOT NULL
        AND o.status IN ('PENDING','VERIFYING','EXPIRED')
        AND o.created_at > now() - interval '30 days'
      ORDER BY o.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map(mapOrder);
}

/** Find orders that reference a UPI/UTR reference in metadata or linked transactions. */
export async function findOrdersByReference(reference: string): Promise<Order[]> {
  const res = await query<OrderRow>(
    `SELECT DISTINCT ${ORDER_COLUMNS} FROM payment_orders o
      LEFT JOIN payment_transactions t ON t.order_id = o.id
      WHERE o.provider_payment_id = $1
         OR t.provider_transaction_reference = $1
         OR t.provider_payment_id = $1
      LIMIT 20`,
    [reference],
  );
  return res.rows.map(mapOrder);
}

export async function getStatusHistory(orderPk: string): Promise<
  Array<{
    fromStatus: string | null;
    toStatus: string;
    reasonCode: string;
    actorType: string;
    note: string | null;
    createdAt: Date;
  }>
> {
  const res = await query<{
    from_status: string | null;
    to_status: string;
    reason_code: string;
    actor_type: string;
    note: string | null;
    created_at: Date;
  }>(
    `SELECT from_status, to_status, reason_code, actor_type, note, created_at
       FROM order_status_history WHERE order_pk = $1 ORDER BY created_at ASC, id ASC`,
    [orderPk],
  );
  return res.rows.map((r) => ({
    fromStatus: r.from_status,
    toStatus: r.to_status,
    reasonCode: r.reason_code,
    actorType: r.actor_type,
    note: r.note,
    createdAt: r.created_at,
  }));
}

/** Cross-merchant stats for administrators. */
export async function globalStats(from?: Date, to?: Date): Promise<MerchantStats> {
  const params: unknown[] = [];
  let range = '';
  if (from) {
    params.push(from);
    range += ` AND created_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    range += ` AND created_at <= $${params.length}`;
  }
  const row = await one<Record<string, string>>(
    `SELECT
       count(*)::text AS total_orders,
       count(*) FILTER (WHERE status = 'PAID')::text AS confirmed_paid,
       count(*) FILTER (WHERE status IN ('CREATED','PENDING','VERIFYING'))::text AS pending,
       count(*) FILTER (WHERE status = 'FAILED')::text AS failed,
       count(*) FILTER (WHERE status = 'EXPIRED')::text AS expired,
       count(*) FILTER (WHERE status = 'REVIEW_REQUIRED')::text AS review_required,
       count(*) FILTER (WHERE status = 'LATE_PAYMENT')::text AS late_payments,
       COALESCE(sum(paid_amount_paise) FILTER (WHERE status IN ('PAID','LATE_PAYMENT','PARTIALLY_REFUNDED','REFUND_PENDING')), 0)::text AS confirmed_value,
       COALESCE(sum(refunded_paise), 0)::text AS refunded_value
     FROM payment_orders WHERE 1=1 ${range}`,
    params,
  );
  return {
    totalOrders: Number(row?.total_orders ?? 0),
    confirmedPaid: Number(row?.confirmed_paid ?? 0),
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0),
    expired: Number(row?.expired ?? 0),
    reviewRequired: Number(row?.review_required ?? 0),
    latePayments: Number(row?.late_payments ?? 0),
    confirmedValuePaise: Number(row?.confirmed_value ?? 0),
    refundedValuePaise: Number(row?.refunded_value ?? 0),
  };
}

export type MerchantSummary = {
  id: string;
  merchantCode: string;
  businessName: string;
  accountStatus: string;
  verifiedUpi: string | null;
  orders: number;
  paid: number;
  review: number;
  confirmedValuePaise: number;
};

export async function merchantSummaries(): Promise<MerchantSummary[]> {
  const res = await query<{
    id: string;
    merchant_code: string;
    business_name: string;
    account_status: string;
    verified_merchant_upi_id: string | null;
    orders: string;
    paid: string;
    review: string;
    confirmed_value: string;
  }>(
    `SELECT m.id, m.merchant_code, m.business_name, m.account_status, m.verified_merchant_upi_id,
            count(o.id)::text AS orders,
            count(o.id) FILTER (WHERE o.status = 'PAID')::text AS paid,
            count(o.id) FILTER (WHERE o.status IN ('REVIEW_REQUIRED','LATE_PAYMENT'))::text AS review,
            COALESCE(sum(o.paid_amount_paise) FILTER (WHERE o.status IN ('PAID','LATE_PAYMENT','REFUNDED','PARTIALLY_REFUNDED','REFUND_PENDING')), 0)::text AS confirmed_value
       FROM merchants m LEFT JOIN payment_orders o ON o.merchant_id = m.id
      GROUP BY m.id ORDER BY m.business_name`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    merchantCode: r.merchant_code,
    businessName: r.business_name,
    accountStatus: r.account_status,
    verifiedUpi: r.verified_merchant_upi_id,
    orders: Number(r.orders),
    paid: Number(r.paid),
    review: Number(r.review),
    confirmedValuePaise: Number(r.confirmed_value),
  }));
}
