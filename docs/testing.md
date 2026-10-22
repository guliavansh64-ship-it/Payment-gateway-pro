# Tests and evidence

## How to run

```bash
# PostgreSQL must be running and payment_gateway_test must exist
createdb -h 127.0.0.1 -p 55432 -U app payment_gateway_test   # once

npm test                 # vitest, 15 files, 125 tests
npm run typecheck        # tsc --noEmit
npm run build            # tsc -p tsconfig.json
npx tsx -r dotenv/config scripts/smoke.ts   # renders every page in-process
```

Last verified result:

```
Test Files  15 passed (15)
     Tests  125 passed (125)
tsc --noEmit: clean
npm run build: clean
```

Tests run in one fork against one database and truncate between cases, so they
are deterministic but not parallel. They never call a real provider, Google, or
any network endpoint; `tests/setup/env.ts` strips provider/Google credentials
and re-applies a clean environment before every test.

## Inventory

| File | Tests | Covers |
| --- | --- | --- |
| `tests/unit/crypto.test.ts` | 8 | AES-256-GCM round-trip/AAD/tamper, key rotation, scrypt, constant-time compare, HMAC |
| `tests/unit/gmail-parser.test.ts` | 13 | sender allow-list/spoofing, HTML→text, multipart preference, amount/UTR/VPA extraction, direction, realistic HDFC alert, malformed input |
| `tests/unit/ids.test.ts` | 7 | order-id format, 20k no-collision, non-time-only, Crockford alphabet, normalisation, forged formats, token entropy |
| `tests/unit/money.test.ts` | 6 | exact rupee parsing (no float), rejection of over-precision, formatting, boundaries, under/over comparison, safe sums |
| `tests/unit/status-machine.test.ts` | 6 | happy path, no backward moves from final states, late/refund paths, self-transition rejection, labels |
| `tests/unit/upi.test.ts` | 4 | compliant fixed-amount URI, invalid payee/sub-rupee rejection, name encoding, open-amount omission |
| `tests/integration/orders.test.ts` | 12 | exact paise storage, unique ids, validation, inactive merchant, provider failure → FAILED, verified VPA requirement, raw-SQL immutability, raw-SQL transition guard, append-only audit, expiry (incl. never expiring paid orders), idempotency |
| `tests/integration/matching.test.ts` | 5 | provider reference wins, identical-amount ambiguity, embedded order id with dashes, time window, different merchant |
| `tests/integration/gmail.test.ts` | 8 | email alone cannot pay, email triggers provider check, spoofed sender ignored, message idempotency, identical-order ambiguity, corroboration without double credit, allow-listed sync + cursor, no-domain refusal |
| `tests/integration/webhooks.test.ts` | 15 | provider 404/503, empty/invalid signature, PAID on valid signature, replay, second payment, under/overpay, wrong payee, late payment, stale notification, reversal, unknown order, failed-event reprocessing, probe, concurrency |
| `tests/integration/sandbox-poll.test.ts` | 6 | pending with no provider record, PAID only after provider success, FAILED status, idempotent polls, reversal on poll, simulator cannot self-declare |
| `tests/integration/provider-outage.test.ts` | 6 | create failure → FAILED order, API returns FAILED, status API unreachable, reconciliation errors, webhook retry, health DOWN |
| `tests/integration/rate-limit.test.ts` | 5 | IP login limit, per-account limit + audit, reset on success, status-check throttle, order-creation throttle |
| `tests/integration/review-refunds.test.ts` | 8 | manual approval is not provider proof, reason required, reject path, case assignment, full/partial/over refunds, refunds only on held money, pending refund reconciliation |
| `tests/integration/web.test.ts` | 16 | login CSRF, session cookie + logout, generic auth errors, cross-merchant access, CSRF, admin RBAC, payment page + QR, token required, no self-declare, webhook reflected, sandbox hidden, CSV scoping, search, health/ready, security headers, API order creation |

## The 24 required scenarios → tests

| # | Scenario | Test(s) |
| --- | --- | --- |
| 1 | Exact payment, single order | webhooks: *marks an order PAID from a signature-verified provider event*; sandbox-poll: *pays an order only after the provider reports a successful payment* |
| 2 | Underpayment | webhooks: *records an underpayment without marking the order PAID* |
| 3 | Excess payment | webhooks: *records an excess payment for review instead of over-crediting* |
| 4 | Duplicate payment for the same order | webhooks: *treats a second, different payment for the same order as duplicate money* |
| 5 | Payment matching no order | webhooks: *records money from an unknown order without attaching it to any order* |
| 6 | Two identical-amount orders (ambiguity) | matching: *routes an unidentifiable payment between identical orders to review*; gmail: *does not guess between two identical orders* |
| 7 | Late payment | webhooks: *records a late payment as LATE_PAYMENT and keeps money acknowledged*; unit: *models late payment and refund paths* |
| 8 | Wrong merchant / wrong UPI ID | webhooks: *never pays an order from a payment to a different payee*; matching: *ignores a payment for a different merchant account* |
| 9 | Failed payment at the provider | sandbox-poll: *does not pay an order from a provider FAILED status* |
| 10 | Reversed payment | webhooks: *records a provider-side reversal and moves the order out of PAID*; sandbox-poll: *marks a provider-reported reversal for review on the next poll* |
| 11 | Refunded payment | review-refunds: *refunds in full and moves the order to REFUNDED*; *supports partial refunds and refuses to over-refund* |
| 12 | Gmail-only "payment received" | gmail: *cannot mark an order paid on its own (no status API)*; *triggers an authoritative provider check that can confirm payment* |
| 13 | Spoofed/forwarded Gmail alert | gmail: *ignores a spoofed sender and stores no transaction*; unit: *rejects a spoofed display name*, *does not accept lookalike domains*, *down-weights forwarded alerts* |
| 14 | HTML-only bank email | unit: *converts HTML to readable text*, *prefers the plain part of a multipart message* |
| 15 | Multiple payments for one order | webhooks (duplicate money) + orders: *is idempotent* |
| 16 | Webhook replay | webhooks: *acknowledges a replayed event ID as DUPLICATE without double-crediting* |
| 17 | Invalid webhook signature | webhooks: *refuses an empty body and an invalid signature* |
| 18 | Provider outage | provider-outage: all 6 tests |
| 19 | Rate limiting | rate-limit: all 5 tests |
| 20 | Manual override / review decision | review-refunds: *approves a case as MANUALLY_VERIFIED without fabricating provider proof*, *requires a written reason and refuses a second decision*, *rejects a case and returns the order to a payable state* |
| 21 | RBAC | web: *blocks merchants from admin pages*, *redirects anonymous users to login and forbids cross-merchant access* |
| 22 | CSRF | web: *requires a CSRF token for state-changing requests*, *serves the login page and rejects a login without the pre-auth token* |
| 23 | Expiry | orders: *expires unpaid orders and records why*, *never expires an order that already holds a payment* |
| 24 | Concurrency / duplicate delivery | webhooks: *survives a concurrent double delivery with exactly one credit*; gmail: *processes the same message id only once* |

Additional scenarios covered beyond the list: inactive merchant, provider
failure at creation, currency mismatch, raw-SQL immutability, append-only
audit, security headers, CSV scoping, health probes, sandbox disablement,
refund settlement reconciliation, provider health.

## Simulation is labelled

- The sandbox adapter is a test double. `ALLOW_SANDBOX_PROVIDER=true` is needed,
  it is refused in production, and the customer page shows "SANDBOX — no real
  money".
- `tests/helpers/fixtures.ts` inserts sandbox payments only into
  `sandbox_payments`; every assertion about money lives in
  `payment_transactions`/`payment_orders`.
- No test asserts that a real Razorpay/Cashfree/Google endpoint was called. The
  live adapters are exercised only for configuration and error mapping.

## What is not covered by automated tests

- Live provider sandbox/live credentials (no keys exist in this repo).
- Google OAuth consent flow (requires a real Google project and browser).
- SMTP/email deliverability (the product sends no email).
- Load/performance testing.
- Browser-level visual regression (the smoke script renders pages in-process but
  does not assert layout).

These are listed in [limitations.md](limitations.md) so a pilot reviewer does not
mistake absence of evidence for evidence of absence.
