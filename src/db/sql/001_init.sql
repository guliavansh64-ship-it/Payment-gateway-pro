-- ===========================================================================
-- 001_init.sql — core schema for the UPI payment verification platform
--
-- Design rules encoded here:
--   * money is BIGINT paise, never floating point
--   * every status change is appended to an immutable history table
--   * a provider transaction can exist at most once (dedupe at storage level)
--   * at most one payment may be credited to an order (no double credit)
--   * audit logs and status history are append-only at the database level
-- ===========================================================================

-- gen_random_uuid() is built in from PostgreSQL 13+; no extension is required,
-- which keeps the migration runnable on managed databases without superuser.

-- ---------------------------------------------------------------------------
-- users & sessions
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  email           TEXT NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  role            TEXT NOT NULL CHECK (role IN ('USER', 'MERCHANT_ADMIN', 'ADMIN', 'AUDITOR')),
  password_hash   TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  failed_logins   INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));

CREATE TABLE user_sessions (
  -- Only a hash of the session token is stored. A leaked database cannot be
  -- replayed as live sessions.
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash         TEXT NOT NULL UNIQUE,
  csrf_token_hash    TEXT NOT NULL,
  elevated_until     TIMESTAMPTZ,
  ip_hash            TEXT,
  user_agent_hash    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_expiry_idx ON user_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- merchants
-- ---------------------------------------------------------------------------
CREATE TABLE merchants (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  merchant_code             TEXT NOT NULL UNIQUE CHECK (merchant_code ~ '^MERCHANT-[0-9]{4,10}$'),
  business_name             TEXT NOT NULL CHECK (length(btrim(business_name)) BETWEEN 1 AND 160),
  -- Only a UPI ID that an operator has verified out-of-band may live here.
  verified_merchant_upi_id  TEXT CHECK (verified_merchant_upi_id ~ '^[a-zA-Z0-9.\-_]{2,60}@[a-zA-Z][a-zA-Z0-9.\-]{1,40}$'),
  upi_verified_at           TIMESTAMPTZ,
  upi_verified_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  provider_account_id       TEXT,
  account_status            TEXT NOT NULL DEFAULT 'PENDING'
                              CHECK (account_status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED')),
  -- Merchant policy applied to confirmed payments that arrive after expiry.
  late_payment_policy       TEXT NOT NULL DEFAULT 'REVIEW'
                              CHECK (late_payment_policy IN ('FULFIL', 'REFUND', 'REVIEW')),
  default_provider          TEXT,
  branding_color            TEXT DEFAULT '#0f766e' CHECK (branding_color ~ '^#[0-9a-fA-F]{6}$'),
  support_email             TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merchants_upi_verified_together CHECK (
    (verified_merchant_upi_id IS NULL AND upi_verified_at IS NULL)
    OR (verified_merchant_upi_id IS NOT NULL AND upi_verified_at IS NOT NULL)
  )
);
CREATE INDEX merchants_owner_idx ON merchants (owner_id);
CREATE INDEX merchants_upi_idx ON merchants (verified_merchant_upi_id) WHERE verified_merchant_upi_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- provider configuration (admin managed; never stores secrets)
-- ---------------------------------------------------------------------------
CREATE TABLE provider_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name    TEXT NOT NULL UNIQUE,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  mode             TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live', 'sandbox', 'production')),
  -- Non-secret configuration only (e.g. display name, priority, merchant id).
  public_config    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Secrets live in the environment / managed secret store, referenced by name.
  secret_ref       TEXT,
  last_health_at   TIMESTAMPTZ,
  last_health_status TEXT CHECK (last_health_status IN ('OK', 'DEGRADED', 'DOWN', 'UNKNOWN')),
  last_health_detail TEXT,
  updated_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE provider_configs ADD CONSTRAINT provider_configs_no_secrets CHECK (
  NOT (public_config ? 'secret') AND NOT (public_config ? 'key_secret')
  AND NOT (public_config ? 'webhook_secret') AND NOT (public_config ? 'client_secret')
);

-- ---------------------------------------------------------------------------
-- payment orders
-- ---------------------------------------------------------------------------
CREATE TABLE payment_orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              TEXT NOT NULL UNIQUE CHECK (order_id ~ '^PAY-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$'),
  merchant_id           UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  amount_paise          BIGINT NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 100000000000),
  currency              TEXT NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  payment_method        TEXT NOT NULL CHECK (payment_method IN ('UPI_QR', 'UPI_ID', 'UPI_INTENT')),
  provider_name         TEXT NOT NULL,
  provider_payment_id   TEXT,
  -- Customer-facing link token. Unguessable; grants read-only order status.
  public_token          TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'CREATED'
                          CHECK (status IN ('CREATED','PENDING','VERIFYING','PAID','FAILED','EXPIRED',
                                            'REVIEW_REQUIRED','LATE_PAYMENT','REFUND_PENDING',
                                            'REFUNDED','PARTIALLY_REFUNDED')),
  verification_status   TEXT NOT NULL DEFAULT 'UNVERIFIED'
                          CHECK (verification_status IN ('UNVERIFIED','PENDING_AUTHORITATIVE',
                                            'VERIFIED','MANUALLY_VERIFIED','VERIFICATION_FAILED','REVIEW_REQUIRED')),
  -- Snapshotted at creation: must never be recomputed from mutable merchant data.
  upi_payee_vpa         TEXT,
  upi_payee_name        TEXT,
  qr_payload            TEXT,
  description           TEXT CHECK (description IS NULL OR length(description) <= 200),
  customer_reference    TEXT CHECK (customer_reference IS NULL OR length(customer_reference) <= 80),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  paid_at               TIMESTAMPTZ,
  verification_source   TEXT CHECK (verification_source IN ('PROVIDER_WEBHOOK','PROVIDER_API',
                                            'RECONCILIATION','GMAIL_NOTIFICATION','MANUAL_ENTRY','SANDBOX')),
  verified_at           TIMESTAMPTZ,
  paid_amount_paise     BIGINT CHECK (paid_amount_paise IS NULL OR paid_amount_paise > 0),
  refunded_paise        BIGINT NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_notified_at   TIMESTAMPTZ,
  CONSTRAINT payment_orders_expiry_after_creation CHECK (expires_at > created_at),
  -- paid_at is set exactly when money is believed to be held (or under review
  -- because a confirmed payment arrived but could not be auto-applied).
  CONSTRAINT payment_orders_paid_at_consistency CHECK (
    CASE WHEN status IN ('PAID','LATE_PAYMENT','REFUND_PENDING','REFUNDED','PARTIALLY_REFUNDED')
         THEN paid_at IS NOT NULL
         -- REVIEW_REQUIRED may or may not involve money: an ambiguous match
         -- has no payment yet, a mismatched payment does.
         WHEN status = 'REVIEW_REQUIRED' THEN TRUE
         ELSE paid_at IS NULL END
  ),
  CONSTRAINT payment_orders_refund_le_paid CHECK (
    paid_amount_paise IS NULL OR refunded_paise <= paid_amount_paise
  ),
  CONSTRAINT payment_orders_full_refund_state CHECK (
    status <> 'REFUNDED' OR (paid_amount_paise IS NOT NULL AND refunded_paise = paid_amount_paise)
  ),
  CONSTRAINT payment_orders_partial_refund_state CHECK (
    status <> 'PARTIALLY_REFUNDED'
    OR (paid_amount_paise IS NOT NULL AND refunded_paise > 0 AND refunded_paise < paid_amount_paise)
  )
);
CREATE INDEX payment_orders_merchant_created_idx ON payment_orders (merchant_id, created_at DESC);
CREATE INDEX payment_orders_status_idx ON payment_orders (status);
CREATE INDEX payment_orders_expiry_idx ON payment_orders (expires_at)
  WHERE status IN ('CREATED','PENDING','VERIFYING','EXPIRED');
CREATE INDEX payment_orders_amount_window_idx ON payment_orders (amount_paise, created_at DESC);
CREATE INDEX payment_orders_provider_payment_idx ON payment_orders (provider_name, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX payment_orders_provider_payment_uniq
  ON payment_orders (provider_name, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payment_orders_review_idx ON payment_orders (created_at DESC)
  WHERE status IN ('REVIEW_REQUIRED','LATE_PAYMENT','VERIFYING');

-- ---------------------------------------------------------------------------
-- payment transactions (observed money movements, from any source)
-- ---------------------------------------------------------------------------
CREATE TABLE payment_transactions (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name                  TEXT NOT NULL,
  -- Provider's own transaction id: the strongest matching key we can hold.
  provider_transaction_reference TEXT NOT NULL,
  provider_payment_id            TEXT,
  order_id                       UUID REFERENCES payment_orders(id) ON DELETE RESTRICT,
  merchant_id                    UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  amount_paise                   BIGINT NOT NULL CHECK (amount_paise > 0),
  currency                       TEXT NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  transaction_status             TEXT NOT NULL
                                   CHECK (transaction_status IN ('SUCCESS','FAILED','PENDING','REVERSED','REFUNDED','UNKNOWN')),
  verification_status            TEXT NOT NULL DEFAULT 'UNVERIFIED'
                                   CHECK (verification_status IN ('UNVERIFIED','PENDING_AUTHORITATIVE',
                                             'VERIFIED','MANUALLY_VERIFIED','VERIFICATION_FAILED','REVIEW_REQUIRED')),
  source                         TEXT NOT NULL
                                   CHECK (source IN ('PROVIDER_WEBHOOK','PROVIDER_API','RECONCILIATION',
                                             'GMAIL_NOTIFICATION','MANUAL_ENTRY','SANDBOX')),
  -- SHA-256 of the normalised candidate; used to dedupe Gmail alerts that
  -- arrive twice through different message ids.
  candidate_fingerprint          TEXT,
  payee_vpa                      TEXT,
  payer_reference                TEXT,
  transaction_timestamp          TIMESTAMPTZ NOT NULL,
  verified_at                    TIMESTAMPTZ,
  -- TRUE for the single payment credited to an order; a second successful
  -- payment for the same order stays FALSE and is routed to manual review.
  credited_to_order              BOOLEAN NOT NULL DEFAULT FALSE,
  raw_evidence                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A credited payment must be tied to an order and either provider-verified
  -- or explicitly marked as manually verified by an operator (audited). A
  -- manual entry can therefore never masquerade as provider verification.
  CONSTRAINT payment_transactions_credit_requires_order CHECK (
    credited_to_order = FALSE OR (order_id IS NOT NULL
                                  AND verification_status IN ('VERIFIED','MANUALLY_VERIFIED')
                                  AND transaction_status = 'SUCCESS')
  )
);
-- A provider transaction reference is globally unique per provider:
-- this is what makes "no transaction assigned to multiple orders" structural.
CREATE UNIQUE INDEX payment_transactions_provider_ref_uniq
  ON payment_transactions (provider_name, provider_transaction_reference);
-- No double credit.
CREATE UNIQUE INDEX payment_transactions_single_credit_per_order
  ON payment_transactions (order_id) WHERE credited_to_order;
-- Deduplicate Gmail alerts that report the same underlying transaction.
-- Scoped to Gmail rows: authoritative provider rows are deduplicated by
-- provider_transaction_reference, and the matcher may upgrade a Gmail row in
-- place when the authoritative record for the same reference arrives.
CREATE UNIQUE INDEX payment_transactions_gmail_fingerprint_uniq
  ON payment_transactions (candidate_fingerprint)
  WHERE candidate_fingerprint IS NOT NULL AND source = 'GMAIL_NOTIFICATION';
CREATE INDEX payment_transactions_order_idx ON payment_transactions (order_id);
CREATE INDEX payment_transactions_merchant_created_idx ON payment_transactions (merchant_id, created_at DESC);
CREATE INDEX payment_transactions_status_idx ON payment_transactions (verification_status, transaction_status);
CREATE INDEX payment_transactions_timestamp_idx ON payment_transactions (transaction_timestamp DESC);

-- ---------------------------------------------------------------------------
-- payment events (webhook / notification inbox, idempotent processing)
-- ---------------------------------------------------------------------------
CREATE TABLE payment_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Provider event id when supplied; otherwise a hash of the canonical payload.
  event_id            TEXT NOT NULL UNIQUE,
  order_id            UUID REFERENCES payment_orders(id) ON DELETE SET NULL,
  payment_order_ref   TEXT,
  event_type          TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('PROVIDER_WEBHOOK','PROVIDER_API',
                                        'RECONCILIATION','GMAIL_NOTIFICATION','MANUAL_ENTRY','SANDBOX')),
  source_reference    TEXT,
  event_payload_hash  TEXT NOT NULL,
  payload             JSONB NOT NULL,
  processing_status   TEXT NOT NULL DEFAULT 'RECEIVED'
                        CHECK (processing_status IN ('RECEIVED','PROCESSING','PROCESSED','DUPLICATE','FAILED','IGNORED')),
  processing_attempts INTEGER NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  next_attempt_at     TIMESTAMPTZ,
  last_error          TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_pending_idx ON payment_events (next_attempt_at)
  WHERE processing_status IN ('RECEIVED','FAILED');
CREATE INDEX payment_events_order_idx ON payment_events (order_id);
CREATE INDEX payment_events_received_idx ON payment_events (received_at DESC);

-- ---------------------------------------------------------------------------
-- refunds (only ever created through an authorised provider interface)
-- ---------------------------------------------------------------------------
CREATE TABLE refunds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_pk          UUID NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  transaction_id    UUID REFERENCES payment_transactions(id) ON DELETE RESTRICT,
  provider_name     TEXT NOT NULL,
  provider_refund_id TEXT,
  amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),
  status            TEXT NOT NULL DEFAULT 'REQUESTED'
                      CHECK (status IN ('REQUESTED','PENDING','PROCESSED','FAILED','CANCELLED')),
  reason_code       TEXT NOT NULL CHECK (reason_code IN ('DUPLICATE','FRAUDULENT','REQUESTED_BY_CUSTOMER',
                                        'LATE_PAYMENT','AMOUNT_MISMATCH','OTHER')),
  reason_note       TEXT CHECK (reason_note IS NULL OR length(reason_note) <= 500),
  requested_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refunds_provider_ref_uniq ON refunds (provider_name, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE INDEX refunds_order_idx ON refunds (order_pk);
CREATE INDEX refunds_open_idx ON refunds (status) WHERE status IN ('REQUESTED','PENDING');

-- ---------------------------------------------------------------------------
-- Gmail connections (OAuth; refresh token encrypted with envelope encryption)
-- ---------------------------------------------------------------------------
CREATE TABLE gmail_connections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id             UUID REFERENCES merchants(id) ON DELETE SET NULL,
  provider_email          TEXT NOT NULL CHECK (position('@' IN provider_email) > 1),
  -- Ciphertext only: iv.tag.ciphertext, encrypted with the server keyring.
  encrypted_refresh_token TEXT NOT NULL,
  token_key_version       TEXT NOT NULL,
  granted_scopes          TEXT[] NOT NULL DEFAULT '{}',
  connection_status       TEXT NOT NULL DEFAULT 'CONNECTED'
                            CHECK (connection_status IN ('CONNECTED','DEGRADED','REVOKED','ERROR')),
  last_sync_at            TIMESTAMPTZ,
  last_error              TEXT,
  history_cursor          TEXT,
  last_message_at         TIMESTAMPTZ,
  watch_expires_at        TIMESTAMPTZ,
  consecutive_failures    INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX gmail_connections_user_uniq ON gmail_connections (user_id);
CREATE UNIQUE INDEX gmail_connections_email_uniq ON gmail_connections (lower(provider_email));
CREATE INDEX gmail_connections_status_idx ON gmail_connections (connection_status);

-- ---------------------------------------------------------------------------
-- reconciliation cases (human review queue)
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_cases (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id               UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  candidate_transaction_id  UUID REFERENCES payment_transactions(id) ON DELETE RESTRICT,
  order_id                  UUID REFERENCES payment_orders(id) ON DELETE RESTRICT,
  possible_order_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason                    TEXT NOT NULL CHECK (reason IN ('AMBIGUOUS_MATCH','MISSING_REFERENCE',
                                         'AMOUNT_MISMATCH','WRONG_MERCHANT','DUPLICATE_PAYMENT',
                                         'LATE_PAYMENT','TRANSACTION_REVERSED','PROVIDER_UNAVAILABLE',
                                         'GMAIL_UNVERIFIED','WEBHOOK_UNVERIFIABLE','OTHER')),
  detail                    TEXT,
  resolution_status         TEXT NOT NULL DEFAULT 'OPEN'
                              CHECK (resolution_status IN ('OPEN','RESOLVED_PAID','RESOLVED_REJECTED',
                                              'RESOLVED_REFUNDED','ESCALATED')),
  resolution_note           TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 2000),
  reviewed_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Resolution may be performed by the system (reviewed_by NULL) or a human.
  -- A closed case must carry a note. System resolutions (e.g. a provider
  -- confirmed the payment minutes later) have no human reviewer, so
  -- reviewed_at may stay NULL; manual resolutions always set both.
  CONSTRAINT reconciliation_cases_resolution_fields CHECK (
    resolution_status = 'OPEN' OR (resolution_note IS NOT NULL AND length(resolution_note) > 0)
  )
);
-- One open case per candidate transaction.
CREATE UNIQUE INDEX reconciliation_cases_open_candidate_uniq
  ON reconciliation_cases (candidate_transaction_id)
  WHERE resolution_status = 'OPEN' AND candidate_transaction_id IS NOT NULL;
CREATE INDEX reconciliation_cases_merchant_idx ON reconciliation_cases (merchant_id, created_at DESC);
CREATE INDEX reconciliation_cases_open_idx ON reconciliation_cases (created_at DESC)
  WHERE resolution_status = 'OPEN';
CREATE INDEX reconciliation_cases_order_idx ON reconciliation_cases (order_id);

-- ---------------------------------------------------------------------------
-- append-only history for order status changes
-- ---------------------------------------------------------------------------
CREATE TABLE order_status_history (
  id            BIGSERIAL PRIMARY KEY,
  order_pk      UUID NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason_code   TEXT NOT NULL,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('SYSTEM','PROVIDER','USER','ADMIN')),
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_pk, created_at);

-- ---------------------------------------------------------------------------
-- audit logs (append-only, sanitised metadata only)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id                 BIGSERIAL PRIMARY KEY,
  actor_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_type         TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (actor_type IN ('SYSTEM','USER','ADMIN','PROVIDER','CUSTOMER')),
  action             TEXT NOT NULL,
  resource_type      TEXT NOT NULL,
  resource_id        TEXT,
  sanitized_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_hash            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id);

-- ---------------------------------------------------------------------------
-- reconciliation runs (observability for the worker)
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_runs (
  id             BIGSERIAL PRIMARY KEY,
  run_type       TEXT NOT NULL CHECK (run_type IN ('EXPIRY_SWEEP','PROVIDER_RECON','GMAIL_POLL',
                                    'EVENT_RETRY','RETENTION','HEALTH_CHECK')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','OK','PARTIAL','FAILED')),
  items_checked  INTEGER NOT NULL DEFAULT 0,
  items_changed  INTEGER NOT NULL DEFAULT 0,
  error_detail   TEXT
);

-- ---------------------------------------------------------------------------
-- append-only enforcement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_retention_purge', TRUE) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION '% is append-only; deletion requires the retention job', TG_TABLE_NAME;
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER order_status_history_append_only
  BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER payment_events_no_delete
  BEFORE DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- updated_at maintenance
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER merchants_touch BEFORE UPDATE ON merchants FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER payment_orders_touch BEFORE UPDATE ON payment_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER payment_transactions_touch BEFORE UPDATE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER refunds_touch BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER gmail_connections_touch BEFORE UPDATE ON gmail_connections FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER reconciliation_cases_touch BEFORE UPDATE ON reconciliation_cases FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
