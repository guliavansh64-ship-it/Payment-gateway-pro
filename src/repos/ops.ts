import type { PoolClient } from 'pg';
import { getPool, one, query } from '../db/pool';
import type {
  AuditLog,
  GmailConnection,
  ProviderConfig,
  ReconciliationCase,
  ReconciliationReason,
  Refund,
} from '../domain/models';

// ---------------------------------------------------------------------------
// reconciliation cases
// ---------------------------------------------------------------------------

type CaseRow = {
  id: string;
  merchant_id: string;
  candidate_transaction_id: string | null;
  order_id: string | null;
  possible_order_ids: string[];
  reason: ReconciliationReason;
  detail: string | null;
  resolution_status: ReconciliationCase['resolutionStatus'];
  resolution_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
};

function mapCase(row: CaseRow): ReconciliationCase {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    candidateTransactionId: row.candidate_transaction_id,
    orderPk: row.order_id,
    possibleOrderIds: row.possible_order_ids ?? [],
    reason: row.reason,
    detail: row.detail,
    resolutionStatus: row.resolution_status,
    resolutionNote: row.resolution_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

const CASE_COLUMNS = `id, merchant_id, candidate_transaction_id, order_id, possible_order_ids, reason,
  detail, resolution_status, resolution_note, reviewed_by, reviewed_at, created_at`;

/**
 * Opens a review case. Idempotent per candidate transaction: if an open case
 * already exists the existing one is returned (no duplicate queue entries for
 * retried webhooks).
 */
export async function openReconciliationCase(
  input: {
    merchantId: string;
    candidateTransactionId: string | null;
    orderPk: string | null;
    possibleOrderIds: string[];
    reason: ReconciliationReason;
    detail: string;
  },
  client?: PoolClient,
): Promise<ReconciliationCase> {
  const sql = `INSERT INTO reconciliation_cases
      (merchant_id, candidate_transaction_id, order_id, possible_order_ids, reason, detail)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     ON CONFLICT (candidate_transaction_id) WHERE resolution_status = 'OPEN' AND candidate_transaction_id IS NOT NULL
     DO UPDATE SET detail = reconciliation_cases.detail
     RETURNING ${CASE_COLUMNS}`;
  const params = [
    input.merchantId,
    input.candidateTransactionId,
    input.orderPk,
    JSON.stringify(input.possibleOrderIds),
    input.reason,
    input.detail.slice(0, 2000),
  ];
  const row = client
    ? (await client.query<CaseRow>(sql, params)).rows[0]
    : await one<CaseRow>(sql, params);
  if (!row) throw new Error('Failed to open reconciliation case');
  return mapCase(row);
}

export async function findReconciliationCase(id: string): Promise<ReconciliationCase | null> {
  const row = await one<CaseRow>(`SELECT ${CASE_COLUMNS} FROM reconciliation_cases WHERE id = $1`, [id]);
  return row ? mapCase(row) : null;
}

export async function listReconciliationCases(filters: {
  merchantId?: string;
  status?: ReconciliationCase['resolutionStatus'];
  limit?: number;
  offset?: number;
}): Promise<{ rows: ReconciliationCase[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.merchantId) {
    params.push(filters.merchantId);
    clauses.push(`merchant_id = $${params.length}`);
  }
  params.push(filters.status ?? 'OPEN');
  clauses.push(`resolution_status = $${params.length}`);
  const where = `WHERE ${clauses.join(' AND ')}`;
  const total = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM reconciliation_cases ${where}`,
    params,
  );
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const res = await query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM reconciliation_cases ${where}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { rows: res.rows.map(mapCase), total: Number(total?.count ?? 0) };
}

export async function resolveReconciliationCase(
  client: PoolClient,
  input: {
    id: string;
    resolution: Exclude<ReconciliationCase['resolutionStatus'], 'OPEN'>;
    note: string;
    reviewedBy: string;
  },
): Promise<ReconciliationCase> {
  const res = await client.query<CaseRow>(
    `UPDATE reconciliation_cases
        SET resolution_status = $2, resolution_note = $3, reviewed_by = $4, reviewed_at = now()
      WHERE id = $1 AND resolution_status = 'OPEN'
      RETURNING ${CASE_COLUMNS}`,
    [input.id, input.resolution, input.note.slice(0, 2000), input.reviewedBy],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Case not found or already resolved');
  return mapCase(row);
}

export async function findOpenCaseForOrder(
  client: PoolClient,
  orderPk: string,
): Promise<ReconciliationCase | null> {
  const res = await client.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM reconciliation_cases
      WHERE order_id = $1 AND resolution_status = 'OPEN' ORDER BY created_at DESC LIMIT 1`,
    [orderPk],
  );
  return res.rows[0] ? mapCase(res.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// audit logs
// ---------------------------------------------------------------------------

export async function writeAudit(
  input: {
    actorId: string | null;
    actorType: AuditLog['actorType'];
    action: string;
    resourceType: string;
    resourceId: string | null;
    metadata?: Record<string, unknown>;
    ipHash?: string | null;
  },
  client?: PoolClient,
): Promise<void> {
  const sql = `INSERT INTO audit_logs (actor_id, actor_type, action, resource_type, resource_id,
                 sanitized_metadata, ip_hash)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  const params = [
    input.actorId,
    input.actorType,
    input.action,
    input.resourceType,
    input.resourceId,
    JSON.stringify(input.metadata ?? {}),
    input.ipHash ?? null,
  ];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

export async function listAuditLogs(filters: {
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}): Promise<{ rows: AuditLog[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (filters.resourceType) add('resource_type = ?', filters.resourceType);
  if (filters.resourceId) add('resource_id = ?', filters.resourceId);
  if (filters.actorId) add('actor_id = ?', filters.actorId);
  if (filters.action) add('action = ?', filters.action);
  if (filters.from) add('created_at >= ?', filters.from);
  if (filters.to) add('created_at <= ?', filters.to);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = await one<{ count: string }>(`SELECT count(*)::text AS count FROM audit_logs ${where}`, params);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const res = await query<{
    id: string;
    actor_id: string | null;
    actor_type: AuditLog['actorType'];
    action: string;
    resource_type: string;
    resource_id: string | null;
    sanitized_metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, actor_id, actor_type, action, resource_type, resource_id, sanitized_metadata, created_at
       FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    total: Number(total?.count ?? 0),
    rows: res.rows.map((r) => ({
      id: String(r.id),
      actorId: r.actor_id,
      actorType: r.actor_type,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      sanitizedMetadata: r.sanitized_metadata,
      createdAt: r.created_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// refunds
// ---------------------------------------------------------------------------

type RefundRow = {
  id: string;
  order_pk: string;
  transaction_id: string | null;
  provider_name: string;
  provider_refund_id: string | null;
  amount_paise: string;
  status: Refund['status'];
  reason_code: Refund['reasonCode'];
  reason_note: string | null;
  requested_by: string | null;
  requested_at: Date;
  processed_at: Date | null;
};

function mapRefund(row: RefundRow): Refund {
  return {
    id: row.id,
    orderPk: row.order_pk,
    transactionId: row.transaction_id,
    providerName: row.provider_name,
    providerRefundId: row.provider_refund_id,
    amountPaise: Number(row.amount_paise),
    status: row.status,
    reasonCode: row.reason_code,
    reasonNote: row.reason_note,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    processedAt: row.processed_at,
  };
}

export async function insertRefund(
  client: PoolClient,
  input: {
    orderPk: string;
    transactionId: string | null;
    providerName: string;
    amountPaise: number;
    reasonCode: Refund['reasonCode'];
    reasonNote: string | null;
    requestedBy: string | null;
    status?: Refund['status'];
  },
): Promise<Refund> {
  const res = await client.query<RefundRow>(
    `INSERT INTO refunds (order_pk, transaction_id, provider_name, amount_paise, status,
        reason_code, reason_note, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, order_pk, transaction_id, provider_name, provider_refund_id, amount_paise, status,
               reason_code, reason_note, requested_by, requested_at, processed_at`,
    [
      input.orderPk,
      input.transactionId,
      input.providerName,
      input.amountPaise,
      input.status ?? 'REQUESTED',
      input.reasonCode,
      input.reasonNote,
      input.requestedBy,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Failed to insert refund');
  return mapRefund(row);
}

export async function updateRefundResult(
  client: PoolClient,
  refundId: string,
  input: { status: Refund['status']; providerRefundId: string | null; response: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `UPDATE refunds SET status = $2, provider_refund_id = COALESCE($3, provider_refund_id),
            provider_response = $4, processed_at = CASE WHEN $2 IN ('PROCESSED','FAILED','CANCELLED')
            THEN now() ELSE processed_at END
      WHERE id = $1`,
    [refundId, input.status, input.providerRefundId, JSON.stringify(input.response)],
  );
}

export async function listRefundsForOrder(orderPk: string): Promise<Refund[]> {
  const res = await query<RefundRow>(
    `SELECT id, order_pk, transaction_id, provider_name, provider_refund_id, amount_paise, status,
            reason_code, reason_note, requested_by, requested_at, processed_at
       FROM refunds WHERE order_pk = $1 ORDER BY requested_at DESC`,
    [orderPk],
  );
  return res.rows.map(mapRefund);
}

export async function sumRefundedPaise(orderPk: string, client?: PoolClient): Promise<number> {
  const sql = `SELECT COALESCE(sum(amount_paise), 0)::text AS total FROM refunds
                WHERE order_pk = $1 AND status IN ('PROCESSED','PENDING')`;
  const row = client ? (await client.query<{ total: string }>(sql, [orderPk])).rows[0] : await one<{ total: string }>(sql, [orderPk]);
  return Number(row?.total ?? 0);
}

// ---------------------------------------------------------------------------
// gmail connections
// ---------------------------------------------------------------------------

type GmailRow = {
  id: string;
  user_id: string;
  merchant_id: string | null;
  provider_email: string;
  encrypted_refresh_token: string;
  token_key_version: string;
  granted_scopes: string[];
  connection_status: GmailConnection['connectionStatus'];
  last_sync_at: Date | null;
  last_error: string | null;
  history_cursor: string | null;
  last_message_at: Date | null;
  watch_expires_at: Date | null;
  consecutive_failures: number;
  created_at: Date;
};

export function mapGmailConnection(row: GmailRow): GmailConnection {
  return {
    id: row.id,
    userId: row.user_id,
    merchantId: row.merchant_id,
    providerEmail: row.provider_email,
    encryptedRefreshToken: row.encrypted_refresh_token,
    tokenKeyVersion: row.token_key_version,
    grantedScopes: row.granted_scopes ?? [],
    connectionStatus: row.connection_status,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    historyCursor: row.history_cursor,
    lastMessageAt: row.last_message_at,
    watchExpiresAt: row.watch_expires_at,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
  };
}

const GMAIL_COLUMNS = `id, user_id, merchant_id, provider_email, encrypted_refresh_token, token_key_version,
  granted_scopes, connection_status, last_sync_at, last_error, history_cursor, last_message_at,
  watch_expires_at, consecutive_failures, created_at`;

export async function upsertGmailConnection(input: {
  userId: string;
  merchantId: string | null;
  providerEmail: string;
  encryptedRefreshToken: string;
  tokenKeyVersion: string;
  grantedScopes: string[];
}): Promise<GmailConnection> {
  const row = await one<GmailRow>(
    `INSERT INTO gmail_connections (user_id, merchant_id, provider_email, encrypted_refresh_token,
        token_key_version, granted_scopes, connection_status)
     VALUES ($1,$2,$3,$4,$5,$6,'CONNECTED')
     ON CONFLICT (user_id) DO UPDATE
       SET provider_email = EXCLUDED.provider_email,
           merchant_id = EXCLUDED.merchant_id,
           encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
           token_key_version = EXCLUDED.token_key_version,
           granted_scopes = EXCLUDED.granted_scopes,
           connection_status = 'CONNECTED',
           last_error = NULL,
           consecutive_failures = 0,
           history_cursor = NULL
     RETURNING ${GMAIL_COLUMNS}`,
    [
      input.userId,
      input.merchantId,
      input.providerEmail,
      input.encryptedRefreshToken,
      input.tokenKeyVersion,
      input.grantedScopes,
    ],
  );
  if (!row) throw new Error('Failed to upsert gmail connection');
  return mapGmailConnection(row);
}

export async function findGmailConnectionByUser(userId: string): Promise<GmailConnection | null> {
  const row = await one<GmailRow>(
    `SELECT ${GMAIL_COLUMNS} FROM gmail_connections WHERE user_id = $1`,
    [userId],
  );
  return row ? mapGmailConnection(row) : null;
}

export async function findGmailConnectionById(id: string): Promise<GmailConnection | null> {
  const row = await one<GmailRow>(`SELECT ${GMAIL_COLUMNS} FROM gmail_connections WHERE id = $1`, [id]);
  return row ? mapGmailConnection(row) : null;
}

export async function listActiveGmailConnections(): Promise<GmailConnection[]> {
  const res = await query<GmailRow>(
    `SELECT ${GMAIL_COLUMNS} FROM gmail_connections
      WHERE connection_status IN ('CONNECTED','DEGRADED') ORDER BY last_sync_at NULLS FIRST`,
  );
  return res.rows.map(mapGmailConnection);
}

export async function updateGmailSyncState(
  id: string,
  input: {
    providedHistoryCursor?: string | null;
    lastMessageAt?: Date | null;
    lastError?: string | null;
    status?: GmailConnection['connectionStatus'];
    scopeIssue?: boolean;
  },
): Promise<void> {
  await query(
    `UPDATE gmail_connections SET
        history_cursor = COALESCE($2, history_cursor),
        last_message_at = COALESCE($3, last_message_at),
        last_sync_at = CASE WHEN $6::boolean THEN last_sync_at ELSE now() END,
        last_error = $4::text,
        connection_status = COALESCE($5::text, connection_status),
        consecutive_failures = CASE WHEN $4::text IS NULL THEN 0 ELSE consecutive_failures + 1 END
      WHERE id = $1`,
    [
      id,
      input.providedHistoryCursor ?? null,
      input.lastMessageAt ?? null,
      input.lastError ?? null,
      input.status ?? null,
      input.scopeIssue ?? false,
    ],
  );
}

export async function markGmailRevoked(id: string, reason: string): Promise<void> {
  await query(
    `UPDATE gmail_connections
        SET connection_status = 'REVOKED', encrypted_refresh_token = 'revoked', last_error = $2
      WHERE id = $1`,
    [id, reason.slice(0, 500)],
  );
}

// ---------------------------------------------------------------------------
// provider configuration
// ---------------------------------------------------------------------------

export async function listProviderConfigs(): Promise<ProviderConfig[]> {
  const res = await query<{
    provider_name: string;
    enabled: boolean;
    mode: string;
    public_config: Record<string, unknown>;
    secret_ref: string | null;
    last_health_at: Date | null;
    last_health_status: ProviderConfig['lastHealthStatus'];
    last_health_detail: string | null;
  }>(
    `SELECT provider_name, enabled, mode, public_config, secret_ref, last_health_at,
            last_health_status, last_health_detail
       FROM provider_configs ORDER BY provider_name`,
  );
  return res.rows.map((r) => ({
    providerName: r.provider_name,
    enabled: r.enabled,
    mode: r.mode,
    publicConfig: r.public_config,
    secretRef: r.secret_ref,
    lastHealthAt: r.last_health_at,
    lastHealthStatus: r.last_health_status,
    lastHealthDetail: r.last_health_detail,
  }));
}

export async function upsertProviderConfig(input: {
  providerName: string;
  enabled: boolean;
  mode: string;
  updatedBy: string;
}): Promise<void> {
  await query(
    `INSERT INTO provider_configs (provider_name, enabled, mode, updated_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (provider_name) DO UPDATE
       SET enabled = EXCLUDED.enabled, mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by`,
    [input.providerName, input.enabled, input.mode, input.updatedBy],
  );
}

export async function isProviderEnabledInDb(providerName: string): Promise<boolean> {
  const row = await one<{ enabled: boolean }>(
    'SELECT enabled FROM provider_configs WHERE provider_name = $1',
    [providerName],
  );
  return row?.enabled ?? false;
}

export async function recordProviderHealth(
  providerName: string,
  status: 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN',
  detail: string,
): Promise<void> {
  await query(
    `UPDATE provider_configs SET last_health_at = now(), last_health_status = $2, last_health_detail = $3
      WHERE provider_name = $1`,
    [providerName, status, detail.slice(0, 500)],
  );
}

// ---------------------------------------------------------------------------
// reconciliation runs (job observability)
// ---------------------------------------------------------------------------

export async function startRun(runType: string): Promise<number> {
  const row = await one<{ id: string }>(
    `INSERT INTO reconciliation_runs (run_type) VALUES ($1) RETURNING id`,
    [runType],
  );
  return Number(row?.id ?? 0);
}

export async function finishRun(
  id: number,
  status: 'OK' | 'PARTIAL' | 'FAILED',
  itemsChecked: number,
  itemsChanged: number,
  errorDetail?: string,
): Promise<void> {
  await query(
    `UPDATE reconciliation_runs SET finished_at = now(), status = $2, items_checked = $3,
            items_changed = $4, error_detail = $5 WHERE id = $1`,
    [id, status, itemsChecked, itemsChanged, errorDetail?.slice(0, 1000) ?? null],
  );
}

export async function listRecentRuns(limit = 20): Promise<
  Array<{
    id: number;
    runType: string;
    startedAt: Date;
    finishedAt: Date | null;
    status: string;
    itemsChecked: number;
    itemsChanged: number;
    errorDetail: string | null;
  }>
> {
  const res = await query<{
    id: string;
    run_type: string;
    started_at: Date;
    finished_at: Date | null;
    status: string;
    items_checked: number;
    items_changed: number;
    error_detail: string | null;
  }>(
    `SELECT id, run_type, started_at, finished_at, status, items_checked, items_changed, error_detail
       FROM reconciliation_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    runType: r.run_type,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    itemsChecked: r.items_checked,
    itemsChanged: r.items_changed,
    errorDetail: r.error_detail,
  }));
}

export async function purgeRetention(retention: {
  paymentEventsDays: number;
  auditLogsDays: number;
}): Promise<{ eventsDeleted: number; auditDeleted: number; sessionsDeleted: number }> {
  const events = await query(
    `DELETE FROM payment_events WHERE received_at < now() - ($1 || ' days')::interval
      AND processing_status IN ('PROCESSED','DUPLICATE','IGNORED')`,
    [retention.paymentEventsDays],
  );
  const sessions = await query("DELETE FROM user_sessions WHERE expires_at < now() - interval '30 days'");
  // Audit retention requires an explicit session flag enforced by the trigger.
  const client = await getPool().connect();
  let auditDeleted = 0;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.allow_retention_purge = 'on'");
    const audit = await client.query(
      `DELETE FROM audit_logs WHERE created_at < now() - ($1 || ' days')::interval`,
      [retention.auditLogsDays],
    );
    auditDeleted = audit.rowCount ?? 0;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return {
    eventsDeleted: events.rowCount ?? 0,
    auditDeleted,
    sessionsDeleted: sessions.rowCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// refund lookup
// ---------------------------------------------------------------------------

export async function findRefundById(id: string): Promise<Refund | null> {
  const row = await one<RefundRow>(
    `SELECT id, order_pk, transaction_id, provider_name, provider_refund_id, amount_paise, status,
            reason_code, reason_note, requested_by, requested_at, processed_at
       FROM refunds WHERE id = $1`,
    [id],
  );
  return row ? mapRefund(row) : null;
}

export async function listRefundsNeedingReconciliation(
  limit = 20,
): Promise<Array<Refund & { orderRef: string }>> {
  const res = await query<RefundRow & { order_ref: string }>(
    `SELECT r.id, r.order_pk, r.transaction_id, r.provider_name, r.provider_refund_id, r.amount_paise,
            r.status, r.reason_code, r.reason_note, r.requested_by, r.requested_at, r.processed_at,
            o.order_id AS order_ref
       FROM refunds r JOIN payment_orders o ON o.id = r.order_pk
      WHERE r.status IN ('REQUESTED','PENDING') AND r.provider_refund_id IS NOT NULL
      ORDER BY r.requested_at ASC LIMIT $1`,
    [limit],
  );
  return res.rows.map((row) => ({ ...mapRefund(row), orderRef: row.order_ref }));
}

export async function listCasesForOrder(orderPk: string): Promise<ReconciliationCase[]> {
  const res = await query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM reconciliation_cases WHERE order_id = $1 ORDER BY created_at DESC`,
    [orderPk],
  );
  return res.rows.map(mapCase);
}

export async function listRateLimits(limit = 50): Promise<
  Array<{ bucket: string; keyPrefix: string; count: number; windowStart: Date }>
> {
  const res = await query<{ bucket: string; key: string; count: number; window_start: Date }>(
    `SELECT bucket, key, count, window_start FROM rate_limits
      ORDER BY count DESC, window_start DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    bucket: r.bucket,
    keyPrefix: r.key.slice(0, 12),
    count: r.count,
    windowStart: r.window_start,
  }));
}
