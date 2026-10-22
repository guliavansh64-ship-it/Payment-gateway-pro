-- ---------------------------------------------------------------------------
-- 003 — sandbox provider state (TEST DOUBLE ONLY)
--
-- Models the "provider side" of a simulated payment so that status polling can
-- be exercised independently of our own ledger. It is only written by the
-- sandbox simulator, which is hard-disabled in production.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sandbox_payments (
  provider_payment_id            TEXT PRIMARY KEY,
  order_reference                TEXT,
  status                         TEXT NOT NULL
                                   CHECK (status IN ('SUCCESS','FAILED','PENDING','REVERSED')),
  amount_paise                   BIGINT NOT NULL CHECK (amount_paise > 0),
  provider_transaction_reference TEXT,
  payee_vpa                      TEXT,
  paid_at                        TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sandbox_payments_order_idx
  ON sandbox_payments (order_reference);

COMMENT ON TABLE sandbox_payments IS
  'Simulated provider-side payment state. Test double; never real money.';
