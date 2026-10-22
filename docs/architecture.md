# Architecture

## Shape of the system

A single Node.js/TypeScript service plus a worker, backed by PostgreSQL. There
is no queue broker to operate: the database is the queue (`payment_events`
inbox) and the ledger.

```
                    ┌──────────────────────────── browser ────────────────────────────┐
                    │  customer /pay/:id        merchant /dashboard      /admin      │
                    └───────────────┬──────────────────┬──────────────────┬──────────┘
                                    │                  │                  │
                             ┌──────▼──────────────────▼──────────────────▼──────┐
                             │            Express app (src/web)                  │
                             │  sessions, CSRF, RBAC, rate limits, helmet/CSP    │
                             └───┬───────────┬───────────────┬──────────────┬────┘
                                 │           │               │              │
        raw-body webhook ────────┘           │               │              └── EJS views
        /webhooks/:provider                  │               │
                                 ┌───────────▼───────────────▼───────────┐
                                 │        services (domain layer)        │
                                 │ orders · payments · matching · review │
                                 │ refunds · reconciliation              │
                                 └───────┬───────────────┬───────┬───────┘
                                         │               │       │
                                 ┌───────▼──────┐ ┌──────▼────┐ ┌▼──────────────┐
                                 │ provider     │ │ Gmail     │ │ PostgreSQL    │
                                 │ adapters     │ │ (readonly)│ │ ledger + inbox│
                                 └──────────────┘ └───────────┘ └───────────────┘
                                                                       ▲
                                         worker (src/worker-entry.ts) ─┘
                                         expiry · provider recon · refunds · gmail · health · retention
```

Module map:

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Zod-validated environment, production guard rails. |
| `src/domain/` | Money (paise), ids, UPI URI, state machine, models. |
| `src/security/` | AES-256-GCM token encryption, scrypt passwords, opaque hashes, HMAC, rate limits. |
| `src/db/` | Pool, transactional helper, migration runner, repos. |
| `src/providers/` | Adapter interface + Razorpay, Cashfree, manual UPI, sandbox. |
| `src/services/` | Order lifecycle, webhook ingestion, matching, review, refunds, reconciliation. |
| `src/gmail/` | OAuth, Gmail client, email parser, candidate ingestion. |
| `src/web/` | Routes, middleware, views, static assets. |
| `src/workers/` | Scheduler and idempotent jobs. |

## Data model

Migrations are numbered, checksummed and applied once (`src/db/migrate.ts`).
`004_integrity.sql` adds database-level guards so a buggy script or a direct
`psql` session cannot violate money rules.

| Table | Purpose |
| --- | --- |
| `users` | Operators and merchant users. Roles `USER`, `MERCHANT_ADMIN`, `ADMIN`, `AUDITOR`. scrypt password hashes, lockout counters. |
| `user_sessions` | Opaque session tokens (hash only), bound CSRF hash, IP/UA hashes, revocation. |
| `merchants` | Business profile, `MERCHANT-nnnn` code, verified UPI ID, account status, default provider. |
| `provider_configs` | Per-provider enable flag, mode, last health result. |
| `payment_orders` | Money and state. `amount_paise BIGINT`, `paid_amount_paise`, `refunded_paise`, currency, payment method, provider references, payee VPA, public token hash, expiry. DB triggers freeze `amount_paise`/`merchant_id` and validate transitions. |
| `order_status_history` | Append-only timeline of every transition with reason and actor. |
| `payment_transactions` | One row per provider/Gmail/manual money event. Unique `(provider_name, provider_transaction_reference)`. `credited_to_order` ensures a transaction can credit only one order. Verification status/source. |
| `payment_events` | Webhook/Gmail inbox: unique `event_id`, payload hash, sanitized payload, processing status, attempts, next retry. Idempotency gate. |
| `reconciliation_cases` | Manual review: reason, detail, candidate, possible orders, resolution, decided-by, decision note. |
| `refunds` | Provider refund records, status, reason code, idempotency. |
| `gmail_connections` | Connected mailbox: encrypted refresh token + key version, granted scopes, history cursor, sync state, revoked-at. |
| `audit_logs` | Append-only actor/action/resource/metadata/ip-hash records. |
| `reconciliation_runs` | Worker run log (checked/changed/errors/status). |
| `rate_limits` | Persistent fixed-window counters for account-level limits. |
| `sandbox_payments` | Simulated "provider side" state for the test double only. |
| `order_status_transitions` | The state machine as data, used by the transition trigger. |

Money columns are integers (paise) or `NUMERIC`; no floating point is used in
application code or in SQL (see `src/domain/money.ts`).

## Identifiers

- Order id: `PAY-YYYYMMDD-XXXXXXXX` where the suffix is 8 Crockford base32
  characters from `crypto.randomBytes` (40 bits of entropy). The date is
  cosmetic; uniqueness comes from the random suffix plus a unique index and a
  retry loop.
- Public token: 32 random bytes, base64url; only hashed forms are stored for
  sessions, while the order token is stored to allow QR URLs (treated as a
  bearer secret, never logged).
- Provider transaction reference (UTR/RRN) is stored separately and normalised
  (uppercase, dashes/spaces removed).

## Matching engine

Input: a candidate (amount, currency, timestamp, provider references, payee
VPA, status) and a merchant. Output: `LINKED`, `ALREADY_LINKED`, `AMBIGUOUS`,
`CONFLICT`, `NO_ORDER` or `INSUFFICIENT_EVIDENCE`, plus evidence strings that are
stored on the case.

Ladder, strongest first:

1. `INTERNAL_REFERENCE` — our order id echoed by the provider.
2. `PROVIDER_PAYMENT_ID` — the provider payment id we stored at creation.
3. `PROVIDER_REFERENCE` — UTR/RRN already attached to an order.
4. `UNIQUE_UPI_REFERENCE` — our order id inside the UPI transaction note.
5. `VPA_AMOUNT_TIME_UNIQUE` — merchant VPA + exact amount + unique in window.
6. `AMOUNT_TIME_UNIQUE` — exact amount + unique in window (weakest; still
   requires exactly one order and no conflicting evidence).

Rules:

- Amounts are compared in paise; currency must match.
- The window is `MATCHING_WINDOW_MINUTES` around the order's validity plus a
  grace period for late confirmation.
- Two open orders with the same amount in the window → `AMBIGUOUS`, never a
  coin flip.
- A provider-issued reference beats any heuristic.
- One transaction may credit at most one order (DB constraint + application
  check). A second payment for an already-paid order is recorded as
  uncredited duplicate money and escalated.
- Wrong payee VPA, currency mismatch, partial/excess amount and provider
  reversal all go to `REVIEW_REQUIRED` with the evidence attached.
- Late but confirmed money becomes `LATE_PAYMENT` (never dropped, never
  silently refunded).
- A stale `PENDING` event never moves a final state backwards.

## Webhook pipeline

1. Raw body captured (`express.raw`, 256 kB) before any JSON parser.
2. Provider known, enabled and configured — otherwise 404/503.
3. Signature verified by the adapter (HMAC or provider scheme); invalid → 401,
   empty/invalid JSON → 400.
4. Replay window checked by the adapter.
5. Event id is unique in `payment_events`. If already processed → `DUPLICATE`
   (200). If a previous attempt failed → reprocessed, not swallowed.
6. Provider payload normalised; sensitive fields stripped before storage.
7. Candidate matched and applied in one DB transaction with row locks.
8. HTTP result: 200 for processed/ignored/duplicate, 503 for retryable
   provider failures. Never 200 for an unverified state change.

No browser-supplied status is ever read on this path.

## State machine

The canonical table lives in `src/domain/status.ts` and is mirrored in
`order_status_transitions` for the trigger.

```
CREATED        → PENDING, FAILED, EXPIRED
PENDING        → VERIFYING, PAID, FAILED, EXPIRED, REVIEW_REQUIRED, LATE_PAYMENT
VERIFYING      → PAID, PENDING, FAILED, EXPIRED, REVIEW_REQUIRED, LATE_PAYMENT
LATE_PAYMENT   → PAID, REFUND_PENDING, REVIEW_REQUIRED, REFUNDED, PARTIALLY_REFUNDED
PAID           → REFUND_PENDING, PARTIALLY_REFUNDED, REFUNDED, REVIEW_REQUIRED
FAILED         → REVIEW_REQUIRED
EXPIRED        → VERIFYING, PAID, LATE_PAYMENT, REVIEW_REQUIRED, REFUND_PENDING, REFUNDED
REVIEW_REQUIRED→ PAID, PENDING, VERIFYING, EXPIRED, FAILED, LATE_PAYMENT,
                 REFUND_PENDING, REFUNDED, PARTIALLY_REFUNDED
REFUND_PENDING → REFUNDED, PARTIALLY_REFUNDED, PAID, REVIEW_REQUIRED
REFUNDED       → REVIEW_REQUIRED
PARTIALLY_REFUNDED → REFUND_PENDING, REFUNDED, REVIEW_REQUIRED
```

`assertTransition` is called inside the same transaction that locks the order
row; the database trigger repeats the check. Field updates (paid amount,
verification state, refunded total) happen in the same `UPDATE` as the status
change so partial-refund CHECK constraints cannot be violated mid-statement.

## Refunds

- Only orders holding confirmed money (`PAID`, `LATE_PAYMENT`,
  `PARTIALLY_REFUNDED`) can be refunded.
- The amount is validated against `paid - already_refunded` in paise.
- A provider refund call is made with our refund id as idempotency key; the
  result is recorded. `PROCESSED` moves money and the order status; `PENDING`
  does not.
- `manual_upi` has no refund API: refunds are refused with an explanation
  rather than faked.
- A reconciliation job and an admin action can settle pending refunds later.

## Background worker

`src/workers/scheduler.ts` (or `RUN_BACKGROUND_JOBS=true` in the web process)
runs:

| Job | What it does |
| --- | --- |
| `sweepExpiredOrders` | Moves unpaid orders past expiry to `EXPIRED` (never ones holding money). |
| `reconcileProviderOrders` | Polls the provider status API for open orders; errors counted, no state invented. |
| `retryFailedEvents` | Retries inbox events whose processing failed, with backoff and attempt caps. |
| `reconcilePendingRefunds` | Queries provider refund status where supported and settles. |
| `pollGmailConnections` | Gmail history sync per connection; revoked tokens disabled. |
| `checkProviderHealth` | Records provider health; skips unconfigured providers. |
| `purgeExpiredData` | Applies retention windows to event payloads and audit logs. |
| `runDailyHousekeeping` | Invariant checks and a summary run record. |

Jobs are idempotent and safe to run concurrently across instances (row locks,
unique keys, `SKIP`-style selection).

## Failure philosophy

- Money evidence is never deleted because processing failed; events move to
  `FAILED` with an attempt counter and are retried.
- Ambiguity is a first-class outcome, not an error to paper over.
- A provider outage must look like an outage: retryable HTTP codes, no state
  change, health recorded.
- Every manual decision needs a reason and an actor.
