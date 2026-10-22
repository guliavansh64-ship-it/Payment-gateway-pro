# UPI Verify — payment collection with authoritative UPI verification

A self-hosted platform that collects UPI payments with a dynamic QR / UPI ID,
then decides whether each payment is real **from a trusted provider or
acquiring-bank confirmation** — never from an email.

> **The one rule everything else follows:** a Gmail/bank-alert notification is
> only a *lead*. It can create an `UNVERIFIED` candidate or open a
> `REVIEW_REQUIRED` case. It can never, by itself, move an order to `PAID`.
> Only a signature-verified provider webhook or an authorised provider status
> API call does that.

Status of this repository: local pilot-ready code base, `125` automated tests
passing, `tsc --noEmit` clean, production build clean. No live provider
credentials are included or required to run it (the sandbox adapter is a test
double).

---

## Contents

1. [What is (and is not) implemented](#1-what-is-and-is-not-implemented)
2. [How a payment is verified](#2-how-a-payment-is-verified)
3. [Quick start (local)](#3-quick-start-local)
4. [Configuration](#4-configuration)
5. [Customer flow](#5-customer-flow)
6. [Merchant dashboard and admin console](#6-merchant-dashboard-and-admin-console)
7. [Order lifecycle](#7-order-lifecycle)
8. [HTTP API](#8-http-api)
9. [Tests and evidence](#9-tests-and-evidence)
10. [Deliverables index](#10-deliverables-index)
11. [Ready-for-pilot checklist](#11-ready-for-pilot-checklist)
12. [Known limitations](#12-known-limitations)

---

## 1. What is (and is not) implemented

| Area | State | Notes |
| --- | --- | --- |
| Server-side order creation, integer paise, immutable amount/merchant | Implemented | Enforced in the service layer **and** by DB triggers. |
| Dynamic UPI QR + UPI intent + UPI ID instructions | Implemented | `manual_upi` renders a locally built UPI URI; providers can supply their own QR/checkout. |
| Razorpay adapter (Orders/QR, payments, refunds, webhooks) | Implemented, **not live-tested here** | Written against Razorpay's public REST API; requires your own keys and a webhook secret. |
| Cashfree adapter (Orders, status, refunds, webhooks) | Implemented, **not live-tested here** | Same caveat; Cashfree's UPI QR lives inside its checkout. |
| Sandbox adapter (test double) | Implemented | Only enabled with `ALLOW_SANDBOX_PROVIDER=true` and `NODE_ENV != production`. Never moves money. |
| Gmail OAuth + polling + parsing + candidate creation | Implemented | OAuth 2.0, `gmail.readonly`, encrypted refresh tokens, history cursor. Supplements verification; never replaces it. |
| Matching engine | Implemented | Reference-first ladder, time window, ambiguity → review. |
| Reconciliation worker | Implemented | Expiry sweep, provider reconciliation, refund reconciliation, Gmail polling, health checks, retention purge. |
| Merchant dashboard, admin console, customer page | Implemented | Server-rendered EJS, mobile-first customer page. |
| Refunds | Implemented | Only through provider APIs; manual USD/UPI transfer is not supported. |
| Direct integration with Google Pay / PhonePe / Paytm / BHIM | **Not implemented as such** | Those apps pay a UPI ID or a provider checkout. There is no public "verify this GPay payment" API to integrate; anything claiming one is a red flag. |
| Bank core-banking / statement APIs | **Not implemented** | No bank API keys exist. Bank statement matching is a human/manual process. |
| Automatic settlement file ingestion | **Not implemented** | Providers that expose settlement reports would need a new adapter method; see [docs/providers.md](docs/providers.md). |
| Card / wallet / netbanking collection | Out of scope | This is a UPI collection product. |

Detailed caveats: [docs/limitations.md](docs/limitations.md).

---

## 2. How a payment is verified

```
provider webhook ──signature──► event inbox (idempotency) ─┐
                                                          ├─► matching engine ─► authoritative apply ─► PAID
provider status API ◄── poll/verify ──────────────────────┘        │
                                                                   └─► REVIEW_REQUIRED (ambiguous / mismatch)
Gmail alert ──► candidate transaction (UNVERIFIED) ──► may *trigger* a provider check
                                                       never credits money itself
```

Trust levels:

| Source | Can create a candidate? | Can set `PAID`? |
| --- | --- | --- |
| Provider webhook (HMAC/secret verified) | Yes | **Yes** |
| Provider status API (`getPaymentStatus`) | Yes | **Yes** |
| Gmail / bank email alert | Yes (`GMAIL_NOTIFICATION`) | **No** |
| Customer browser ("I have paid") | No | **No** |
| Merchant/admin manual approval | Yes (`MANUAL_ENTRY`) | Yes — but recorded as `MANUALLY_VERIFIED`, with a mandatory reason, and it never fabricates a provider transaction |

A Gmail candidate whose reference matches an order can call the provider status
API. If the provider confirms, `PAID` is set from `PROVIDER_API` and the email
is recorded as corroboration only. If the provider does not confirm (or the
provider is `manual_upi`, which has no status API), the case stays in review.

---

## 3. Quick start (local)

Prerequisites: Node.js >= 20.11 and PostgreSQL 14+.

```bash
npm install
cp .env.example .env                     # edit DATABASE_URL and secrets

# 1. Database schema (idempotent, checksummed migrations in src/db/sql)
npm run migrate

# 2. Users + a demo merchant (development only; prints credentials)
npm run seed

# 3. Run the web app
npm run dev                              # http://localhost:3000

# 4. In another terminal: reconciliation/Gmail background jobs
npm run worker
```

The seed prints the demo credentials and creates merchant `MERCHANT-1001`
("Aarav Traders", VPA `aarav.traders@okhdfcbank`). Change them immediately if
the machine is shared. `SEED_PASSWORD` overrides the seed password.

To create a real operator account:

```bash
PROVISION_PASSWORD='…' npm run user:create -- \
  --email ops@example.com --name "Ops" --role ADMIN
```

Health probes: `GET /healthz` (process), `GET /readyz` (database + migrations).

### Tests

```bash
npm test            # 15 files, 125 tests (uses payment_gateway_test)
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.json
npx tsx -r dotenv/config scripts/smoke.ts   # renders every page in-process
```

The test database is `TEST_DATABASE_URL` (default
`postgresql://app:app@127.0.0.1:55432/payment_gateway_test`) and is truncated
between tests. Tests never call a real provider or Google.

---

## 4. Configuration

Every setting is in [`.env.example`](.env.example) with a comment. The
important ones:

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public origin. Must be `https://` in production. Used for OAuth redirects, webhook URLs, CSRF origin checks. |
| `SESSION_SECRET` | >= 32 chars. Signs cookies and derives session/token hashes. |
| `TOKEN_ENCRYPTION_KEYS` | `v1:<base64 32 bytes>,v0:…` — AES-256-GCM keys for Gmail refresh tokens. Rotate by prepending. |
| `COOKIE_SECURE` | Must be `true` in production (config refuses to start otherwise). |
| `ALLOW_SANDBOX_PROVIDER` | Test double. Refused in production. |
| `MATCHING_WINDOW_MINUTES` | How far around the order window a candidate is considered. |
| `RUN_BACKGROUND_JOBS` | Run the scheduler inside the web process. Production should use a separate worker. |
| `GMAIL_ALLOWED_SENDER_DOMAINS` | Comma-separated. Empty disables Gmail monitoring entirely. |
| `RETENTION_*_DAYS` | Purge window for event payloads and audit logs. |

Production guard rails enforced in `src/config.ts`: HTTPS `APP_URL`,
secure cookies, non-placeholder session secret, sandbox disabled, a webhook
secret whenever a provider key is present, HTTPS OAuth redirect.

---

## 5. Customer flow

1. Merchant creates the order **server-side** (dashboard or `POST /api/orders`).
   The amount is parsed to integer paise; the order id is
   `PAY-YYYYMMDD-XXXXXXXX` from a CSPRNG — never timestamp-only.
2. The customer receives `/pay/PAY-…?t=<public token>`.
3. The page shows the QR, payee UPI ID (never the merchant's private details),
   amount, expiry and status.
4. The customer pays in their own UPI app. The platform never asks for a PIN,
   OTP, bank password or Gmail password, and never renders a bank look-alike
   screen.
5. The page polls `/pay/:id/status` and offers "Check now"
   (`/pay/:id/check`), which asks the provider — not the browser.
6. A provider webhook, a status poll or a Gmail lead feeds the matching engine.
7. Ambiguity or mismatches become `REVIEW_REQUIRED`; the customer sees "under
   review", not "paid".
8. Terminal states are final; late money becomes `LATE_PAYMENT` (money is
   acknowledged, the order is flagged), never silently dropped.
9. Refunds are initiated from the dashboard and settled through the provider.
10. Every state change appears on the order timeline and in `audit_logs`.

The customer page is deliberately mobile-first and never exposes a "mark as
paid" control.

---

## 6. Merchant dashboard and admin console

Merchant (`/dashboard`, roles `MERCHANT_ADMIN`, `ADMIN`, `AUDITOR`):

- metrics: today's collected amount, paid/pending/review counts, recent orders;
- order search by order id, UTR/reference, status, date range; CSV export;
- order detail: timeline, evidence (transactions with verification source),
  provider references, refund actions (step-up protected);
- review queue: approve/reject with a required written reason;
- reconciliation: cases, runs, refund settlement status;
- Gmail connection: connect, sync state, disconnect/revoke, sender allowlist
  status (read-only from config);
- audit log and provider health.

Admin (`/admin`, role `ADMIN`):

- provider configuration/health (read + enable/disable);
- merchants: create/verify UPI ID, activate/suspend;
- all reconciliation cases, audit log, users, security overview;
- refund reconciliation for stuck refunds.

Every override is reason-coded, written to `audit_logs`, and cannot create a
fake provider reference.

---

## 7. Order lifecycle

```
CREATED ──► PENDING ──► VERIFYING ──► PAID ──► REFUND_PENDING ──► REFUNDED
   │           │            │           │                        └► PARTIALLY_REFUNDED
   │           │            │           └──► REVIEW_REQUIRED ──► (human decision)
   │           │            └──► FAILED / EXPIRED / LATE_PAYMENT
   │           └──► EXPIRED / LATE_PAYMENT / REVIEW_REQUIRED / FAILED
   └──► FAILED / EXPIRED
```

- `LATE_PAYMENT`: confirmed money arrived after the window closed. Money is
  acknowledged (`paid_amount_paise` set), a case is opened. Never downgraded by
  a stale notification.
- `REVIEW_REQUIRED`: ambiguity, amount/currency/payee mismatch, reversal,
  duplicate money, or a manual decision pending.
- Terminal: `PAID`, `FAILED`, `EXPIRED`, `REFUNDED`, `PARTIALLY_REFUNDED`.
  `PAID` may still move to a refund state; nothing moves backwards
  automatically.
- The same table exists in the database (`order_status_transitions`) and a
  trigger rejects illegal updates even from `psql`.

Full transition table: [docs/architecture.md](docs/architecture.md#state-machine).

---

## 8. HTTP API

Merchant API (`/api`, session cookie + `x-csrf-token`):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/orders` | Create an order. Body: `amount` (rupees string), `description?`, `payment_method` (`UPI_QR`/`UPI_ID`/`UPI_INTENT`), `provider?`, `customer_reference?`, `expires_in_minutes?`. |
| `GET` | `/api/orders/:orderId` | Status, verification state, amounts, timestamps. |
| `POST` | `/api/orders/:orderId/verify` | Ask the provider for the authoritative status. |
| `GET` | `/api/providers` | Enabled providers and capabilities. |

Public endpoints: `GET /pay/:orderId/qr.png`, `GET /pay/:orderId/status`,
`GET /pay/:orderId/check` (token required).

Provider webhooks: `POST /webhooks/razorpay`, `POST /webhooks/cashfree`
(plus `POST /webhooks/sandbox` when the test double is enabled). These are
unauthenticated by design but signature-verified; see
[docs/providers.md](docs/providers.md).

---

## 9. Tests and evidence

```
Test Files  15 passed (15)
     Tests  125 passed (125)
tsc --noEmit  clean
npm run build clean
scripts/smoke.ts: every dashboard/admin/public page renders (200; 404 expected where anonymous)
```

The matrix mapping the 24 required scenarios to specific tests is in
[docs/testing.md](docs/testing.md). Highlights:

- money is integer paise only (`tests/unit/money.test.ts`);
- 20,000 generated order ids without collision or timestamp dependence
  (`tests/unit/ids.test.ts`);
- raw-SQL attempts to change an order's amount/merchant or jump states are
  rejected by DB triggers (`tests/integration/orders.test.ts`);
- a Gmail alert alone never marks an order paid
  (`tests/integration/gmail.test.ts`);
- duplicate/replayed/concurrent webhooks credit exactly once
  (`tests/integration/webhooks.test.ts`);
- provider outage leaves orders untouched and returns retryable status codes
  (`tests/integration/provider-outage.test.ts`);
- rate limits are enforced (`tests/integration/rate-limit.test.ts`).

---

## 10. Deliverables index

| Requirement | Where |
| --- | --- |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Source code | `src/` (see the module map in the architecture doc) |
| Database schema + migrations | `src/db/sql/001_init.sql` … `004_integrity.sql`, runner `src/db/migrate.ts` |
| `.env.example` (placeholders only) | [`.env.example`](.env.example) |
| Provider adapter interface | `src/providers/types.ts` + four adapters in `src/providers/` |
| Gmail OAuth + polling | `src/gmail/{oauth,client,service,parser}.ts`, [docs/gmail.md](docs/gmail.md) |
| Parsing and matching service | `src/gmail/parser.ts`, `src/services/matching.ts` |
| Webhook endpoints | `src/web/routes/webhooks.ts`, `src/services/payments.ts` |
| Reconciliation worker | `src/workers/{jobs,scheduler}.ts`, `src/worker-entry.ts` |
| Admin dashboard | `src/web/routes/admin.ts`, `src/web/views/admin/` |
| Customer payment page | `src/web/routes/customer.ts`, `src/web/views/pay.ejs` |
| Automated tests | `tests/unit/`, `tests/integration/`, [docs/testing.md](docs/testing.md) |
| Local development | [README §3](#3-quick-start-local) and [docs/deployment.md](docs/deployment.md#local-development) |
| Production deployment | [docs/deployment.md](docs/deployment.md#production) |
| Security checklist | [docs/security.md](docs/security.md) |
| Provider onboarding checklist | [docs/providers.md](docs/providers.md#onboarding-checklist) |
| Google OAuth verification checklist | [docs/gmail.md](docs/gmail.md#google-oauth-verification-checklist) |
| Known limitations | [docs/limitations.md](docs/limitations.md) |

---

## 11. Ready-for-pilot checklist

Each item is satisfiable with the code in this repository and has a test or a
command behind it.

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | Orders are created server-side before instructions are shown | `POST /api/orders` → 201 with `payment_url`; `tests/integration/orders.test.ts` |
| 2 | Order ids are unique and unpredictable | `tests/unit/ids.test.ts` (20k ids, CSPRNG) |
| 3 | Amounts are integer paise; no float anywhere | `tests/unit/money.test.ts`, `NUMERIC`/`BIGINT` columns |
| 4 | Amount and merchant are immutable after creation | DB triggers; "cannot change the amount or merchant, even with raw SQL" |
| 5 | Customer page never self-declares success | "never lets the browser self-declare success" |
| 6 | Snapshots of provider money are confirmed by signature or API | `tests/integration/webhooks.test.ts`, `sandbox-poll.test.ts` |
| 7 | Gmail alone never produces `PAID` | `tests/integration/gmail.test.ts` |
| 8 | Ambiguous matches go to review, not auto-paid | `tests/integration/matching.test.ts` |
| 9 | Replays and concurrent deliveries credit once | webhook replay + concurrency tests |
| 10 | Late, reversed, under/overpaid, wrong-payee cases are handled | webhook suite (6 cases) |
| 11 | Illegal transitions are impossible, including via SQL | DB trigger + `tests/unit/status-machine.test.ts` |
| 12 | Refunds only through provider APIs and never over-refund | `tests/integration/review-refunds.test.ts` |
| 13 | Manual approval cannot fabricate provider proof | `MANUALLY_VERIFIED` + separate `manual_review` ledger entry |
| 14 | Auth, RBAC, CSRF, rate limits enforced | `tests/integration/web.test.ts`, `rate-limit.test.ts` |
| 15 | Audit trail is append-only and complete | DB trigger + admin audit page |
| 16 | Provider outage degrades safely | `tests/integration/provider-outage.test.ts` |
| 17 | Secret handling and encryption keys documented | [docs/security.md](docs/security.md) |
| 18 | Limits and unbuilt integrations are documented | [docs/limitations.md](docs/limitations.md) |

Before a real pilot you must additionally: obtain provider credentials, register
webhook URLs, complete Google OAuth verification for external users, set
`COOKIE_SECURE=true` + HTTPS, run the worker separately, and rehearse the manual
review runbook. See [docs/deployment.md](docs/deployment.md#go-live-checklist).

---

## 12. Known limitations

Short version — full list in [docs/limitations.md](docs/limitations.md):

- Razorpay and Cashfree adapters are written to public API docs but have not
  been exercised against live accounts in this repository.
- No direct UPI-app or bank API integration exists or is claimed.
- Gmail monitoring needs Google OAuth verification (restricted
  `gmail.readonly` scope) before non-test users can connect; until then it is
  limited to test users.
- `manual_upi` orders have no status API: they are confirmed by a human or by a
  provider webhook if one exists.
- Settlement-file ingestion and automatic chargeback handling are not built.
- Refunds depend on the provider exposing refund status; otherwise a human
  reconciles them from the provider dashboard.

---

Security reports and operational questions: read [docs/security.md](docs/security.md)
first. Do not open an issue containing real payment data, tokens or customer
personal information.
