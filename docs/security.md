# Security notes and checklist

This document is written for the person operating the system, not just for a
code reviewer. It lists what is enforced, what you must do at deployment time,
and what remains out of scope.

## Threat model in one page

| Threat | Control |
| --- | --- |
| Customer claims "I paid" from the browser | Payment state is only changed by provider webhook/API or a recorded human decision. The customer page has no write endpoint for status. |
| Forged webhook | Raw-body signature verification per provider, constant-time compare, replay window, unique event ids. Invalid → 401. |
| Replayed/concurrent webhook | `payment_events.event_id` unique; duplicate → 200 without a second credit; row locks serialise concurrent delivery. |
| Fake bank email / spoofed sender | Strict sender allow-list with real address parsing, subdomain rules, forwarded-mail down-weighting, and emails can never set `PAID`. |
| Mismatched or ambiguous amount | Integer paise comparison, exact match required; ambiguity → `REVIEW_REQUIRED`. |
| Merchant changes the amount after the customer pays | DB trigger freezes `amount_paise` and `merchant_id`; service layer validates too. |
| Duplicate credit | One transaction credits one order (`credited_to_order`), unique `(provider, reference)`; second payment becomes uncredited evidence. |
| Refund fraud | Refunds only on orders holding money, amount ≤ paid − refunded, step-up session required, provider API only, audit trail. |
| Admin fabricating a payment | Manual approval writes `MANUALLY_VERIFIED` + `MANUAL_ENTRY`, never a provider reference; requires a written reason; audited. |
| Credential theft from DB dump | Passwords scrypt-hashed; session tokens stored as hashes; Gmail refresh tokens AES-256-GCM encrypted; card data never stored. |
| Session hijack / CSRF | HttpOnly+SameSite=Lax cookie, hashed server-side session, double-submit + hash-bound CSRF token, pre-auth token on login. |
| Brute force | Per-account persistent limiter plus per-IP limiter, account lockout, generic error messages. |
| SQL injection | Parameterised queries everywhere (`pg` placeholders); no string interpolation of user values. |
| XSS | EJS escapes by default (`<%= %>`), CSP `default-src 'self'`, no inline scripts. |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options` via helmet. |
| Log leakage | Tokens, OTP/PIN fields and customer contact fields are redacted; request bodies are not logged. |

## Authentication and authorisation

- Local accounts with scrypt (N=2^15) password hashes and per-user lockout.
- Sessions: 32-byte opaque token in an `HttpOnly`, `SameSite=Lax`,
  `Secure` (in production) cookie. Only `sha256(sessionSecret ⊕ token)` is
  stored. 8-hour idle/absolute lifetime; logout revokes server-side.
- CSRF: the submitted `_csrf` (form field or `x-csrf-token`) must equal the
  `csrf` cookie **and** hash to the value bound to the session at login.
  Machine endpoints (`/webhooks/*`) are exempt because they authenticate by
  signature.
- RBAC: `USER`, `MERCHANT_ADMIN`, `ADMIN`, `AUDITOR`.
  - merchant pages require membership of the merchant (admins may inspect);
  - cross-merchant access returns 403 without leaking existence;
  - `/admin` rejects merchants;
  - mutating routes call `requireCsrf` and, for refunds/overrides, a fresh
    step-up challenge.
- Login CSRF is prevented by a signed pre-authentication token rendered into the
  login form and verified against its cookie.

### Identity-provider MFA

Application-level MFA is not built. For a pilot, put the dashboard behind an
SSO/MFA-capable reverse proxy (or an identity-aware proxy) and keep local
accounts for automation only. This is called out in
[limitations.md](limitations.md).

## Input validation and money

- Every route parses input with Zod schemas; unknown fields are ignored.
- Amounts: strings parsed by `parseRupeesToPaise` to integer paise. No
  `parseFloat` and no floating-point arithmetic in the domain layer.
- Amount bounds: ≥ ₹1 and ≤ `MAX_ORDER_AMOUNT_PAISE`.
- Status changes go through `assertTransition`, mirrored by a DB trigger.
- Output encoding via EJS auto-escaping; URLs built with `encodeURIComponent`.

## Rate limiting

- Persistent, database-backed fixed-window limiters for login by account
  (10 / 15 min) and login by IP (20 / 15 min), plus per-route limits:
  order creation 12/min, status 30/min, status check 10/min.
- Limits are keyed by a hash of the client address (never the raw address in
  logs) and reset on successful login.
- `TRUST_PROXY` must be set correctly: if you run behind a proxy and leave it
  `false`, every client shares one bucket; if you enable it without a trusted
  proxy, clients can spoof their address.

## Secrets and key management

| Secret | Storage | Rotation |
| --- | --- | --- |
| `SESSION_SECRET` | secret manager / env | Rotating invalidates all sessions. Do it during a maintenance window. |
| `TOKEN_ENCRYPTION_KEYS` | secret manager / env | Prepend `v2:<new key>`; keep `v1` until all rows are re-encrypted (`token_key_version` records which key). |
| Provider API keys | secret manager | Rotate in the provider dashboard, deploy, then revoke the old key. |
| Webhook secrets | secret manager | Same; re-register the webhook if the provider requires it. |
| Gmail client secret | secret manager | Rotate in Google Cloud Console; existing refresh tokens remain valid until revoked. |
| DB credentials | secret manager / IAM auth | Rotate with a connection-pool drain. |

Never commit `.env`. `.gitignore` already excludes it. `.env.example` contains
placeholders only. Production startup refuses placeholder secrets, non-HTTPS
`APP_URL`, `COOKIE_SECURE=false` and the sandbox provider.

## Auditability and retention

- `audit_logs` and `order_status_history` are append-only (DB triggers reject
  `UPDATE`/`DELETE`).
- Audited events include: login success/failure/rate limit, order creation,
  webhook rejections, merchant resolution failures, duplicate webhooks,
  transaction corroboration, review decisions, refunds, exports, provider
  configuration changes, merchant status changes, Gmail connect/disconnect.
- Event payloads are sanitised before storage (no email bodies, no customer
  emails/phones); only hashes and non-identifying fields are kept.
- Retention: `RETENTION_PAYMENT_EVENTS_DAYS` (default 180) for event payloads,
  `RETENTION_AUDIT_LOGS_DAYS` (default 730) for audit logs. The purge job runs
  daily; financial ledger rows are retained.
- Data-deletion requests: delete/anonymise the merchant's personal data,
  revoke Gmail tokens, and retain only what is legally required (with the
  reason recorded).

## Deployment controls

- TLS terminated in front of the app; `APP_URL` https; HSTS enabled in
  production.
- Security headers: CSP (`default-src 'self'`, `frame-ancestors 'none'` by
  default, `object-src 'none'`), `nosniff`, `Referrer-Policy: same-origin`.
  `CSP_FRAME_ANCESTORS` exists only for embedding in a trusted shell (preview
  panes); production must keep the default `'none'`. `COOKIE_SAMESITE=none` is
  likewise for cross-site embedding and requires HTTPS + `COOKIE_SECURE`.
- Postgres not exposed publicly; SSL (`PGSSLMODE=require`) for managed
  databases; least-privilege DB role (no superuser for the app).
- Backups encrypted, restore rehearsed; audit logs exported to append-only
  storage.
- Worker runs as a separate process; `RUN_BACKGROUND_JOBS=false` in web.
- Dependency updates: `npm audit` in CI, pinned lockfile, review before merge.

## Monitoring for reconciliation failures

Alert on:

- `reconciliation_runs.status = FAILED` or `errors > 0`;
- `reconciliation_cases` open longer than 24 h;
- paid orders with no credited transaction (daily invariant);
- refunds `PENDING` for more than 24 h;
- `gmail_connections.status != 'CONNECTED'`;
- webhook 5xx rate or signature failures;
- provider health `DOWN`/`DEGRADED`;
- rate-limit 429 spikes on login.

The daily housekeeping job records a summary; export it to your monitoring
system.

## Out of scope / explicitly not stored

- No card numbers, CVV, UPI PIN, OTP, bank passwords or net-banking
  credentials — ever, in any table, log or form.
- No Gmail passwords or app passwords.
- No customer bank account numbers.
- No raw IP addresses in audit logs (only salted hashes).

## Pre-production security checklist

- [ ] `.env` not committed; secrets generated with `crypto.randomBytes`.
- [ ] `SESSION_SECRET` ≥ 32 bytes, unique per environment.
- [ ] `TOKEN_ENCRYPTION_KEYS` generated, backed up, rotation plan written.
- [ ] `COOKIE_SECURE=true`, HTTPS only, HSTS on.
- [ ] `TRUST_PROXY` matches the actual proxy topology.
- [ ] `ALLOW_SANDBOX_PROVIDER=false`.
- [ ] Provider webhook secrets set and webhook URLs registered.
- [ ] `GMAIL_ALLOWED_SENDER_DOMAINS` set to the banks/providers you actually use.
- [ ] DB role is least-privilege; backups encrypted; restore tested.
- [ ] Admin accounts behind SSO/MFA or an identity-aware proxy.
- [ ] Logs shipped off-box; alerting wired to the list above.
- [ ] `npm audit`, `npm run typecheck`, `npm test`, `npm run build` clean.
- [ ] Incident response: who revokes provider keys, who rotates session secrets,
      who contacts affected merchants.
