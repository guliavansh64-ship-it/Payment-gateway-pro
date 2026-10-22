-- ---------------------------------------------------------------------------
-- 004 — database-level integrity guards
--
-- The application already enforces these rules in one place (services/orders.ts).
-- These triggers make the same rules true even for a buggy migration script or a
-- direct psql session, which is what "defence in depth" has to mean for money.
-- ---------------------------------------------------------------------------

-- The state machine, mirrored into the database so both layers agree.
CREATE TABLE IF NOT EXISTS order_status_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO order_status_transitions (from_status, to_status) VALUES
  ('CREATED','PENDING'),
  ('CREATED','FAILED'),
  ('CREATED','EXPIRED'),
  ('PENDING','VERIFYING'),
  ('PENDING','PAID'),
  ('PENDING','FAILED'),
  ('PENDING','EXPIRED'),
  ('PENDING','REVIEW_REQUIRED'),
  ('PENDING','LATE_PAYMENT'),
  ('VERIFYING','PAID'),
  ('VERIFYING','PENDING'),
  ('VERIFYING','FAILED'),
  ('VERIFYING','EXPIRED'),
  ('VERIFYING','REVIEW_REQUIRED'),
  ('VERIFYING','LATE_PAYMENT'),
  ('LATE_PAYMENT','PAID'),
  ('LATE_PAYMENT','REFUND_PENDING'),
  ('LATE_PAYMENT','REVIEW_REQUIRED'),
  ('LATE_PAYMENT','REFUNDED'),
  ('LATE_PAYMENT','PARTIALLY_REFUNDED'),
  ('PAID','REFUND_PENDING'),
  ('PAID','PARTIALLY_REFUNDED'),
  ('PAID','REFUNDED'),
  ('PAID','REVIEW_REQUIRED'),
  ('FAILED','REVIEW_REQUIRED'),
  ('EXPIRED','VERIFYING'),
  ('EXPIRED','PAID'),
  ('EXPIRED','LATE_PAYMENT'),
  ('EXPIRED','REVIEW_REQUIRED'),
  ('EXPIRED','REFUND_PENDING'),
  ('EXPIRED','REFUNDED'),
  ('REVIEW_REQUIRED','PAID'),
  ('REVIEW_REQUIRED','PENDING'),
  ('REVIEW_REQUIRED','VERIFYING'),
  ('REVIEW_REQUIRED','EXPIRED'),
  ('REVIEW_REQUIRED','FAILED'),
  ('REVIEW_REQUIRED','LATE_PAYMENT'),
  ('REVIEW_REQUIRED','REFUND_PENDING'),
  ('REVIEW_REQUIRED','REFUNDED'),
  ('REVIEW_REQUIRED','PARTIALLY_REFUNDED'),
  ('REFUND_PENDING','REFUNDED'),
  ('REFUND_PENDING','PARTIALLY_REFUNDED'),
  ('REFUND_PENDING','PAID'),
  ('REFUND_PENDING','REVIEW_REQUIRED'),
  ('REFUNDED','REVIEW_REQUIRED'),
  ('PARTIALLY_REFUNDED','REFUND_PENDING'),
  ('PARTIALLY_REFUNDED','REFUNDED'),
  ('PARTIALLY_REFUNDED','REVIEW_REQUIRED')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION payment_orders_guard_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM order_status_transitions
       WHERE from_status = OLD.status AND to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'illegal order transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_orders_transition_guard ON payment_orders;
CREATE TRIGGER payment_orders_transition_guard
  BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION payment_orders_guard_transition();

-- The financial identity of an order is fixed at creation. A customer cannot
-- change the amount, and neither can a compromised admin session.
CREATE OR REPLACE FUNCTION payment_orders_guard_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_paise <> OLD.amount_paise
     OR NEW.currency <> OLD.currency
     OR NEW.merchant_id <> OLD.merchant_id
     OR NEW.order_id <> OLD.order_id
     OR NEW.public_token <> OLD.public_token
     OR NEW.upi_payee_vpa IS DISTINCT FROM OLD.upi_payee_vpa THEN
    RAISE EXCEPTION 'payment order financial identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_orders_identity_guard ON payment_orders;
CREATE TRIGGER payment_orders_identity_guard
  BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION payment_orders_guard_identity();

-- Audit records are append-only. Retention deletion is possible only for the
-- maintenance role via a session flag, so an application bug cannot rewrite
-- history.
CREATE OR REPLACE FUNCTION audit_logs_are_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit records are immutable' USING ERRCODE = '23514';
  END IF;
  IF current_setting('app.allow_audit_purge', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'audit records may only be deleted by the retention job'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();

-- Status history is likewise append-only.
CREATE OR REPLACE FUNCTION order_status_history_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'status history is append-only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS order_status_history_no_mutation ON order_status_history;
CREATE TRIGGER order_status_history_no_mutation
  BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION order_status_history_append_only();
