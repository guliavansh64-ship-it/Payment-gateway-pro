-- 002_rate_limits.sql — persistent fixed-window counters for sensitive actions
CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  key          TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count        INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (bucket, key)
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);
