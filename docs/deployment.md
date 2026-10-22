# Local development and production deployment

## Local development

### 1. PostgreSQL

Any Postgres 14+ works. With Docker:

```bash
docker run --name upi-verify-pg -p 55432:5432 \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=payment_gateway \
  -d postgres:16
docker exec -it upi-verify-pg createdb -U app payment_gateway_test
```

Or use an existing local server and create the two databases
(`payment_gateway`, `payment_gateway_test`).

### 2. Application

```bash
npm install
cp .env.example .env
```

Edit at minimum:

```dotenv
DATABASE_URL=postgresql://app:app@127.0.0.1:55432/payment_gateway
SESSION_SECRET=<48 random bytes, base64>
TOKEN_ENCRYPTION_KEYS=v1:<32 random bytes, base64>
COOKIE_SECURE=false
APP_URL=http://localhost:3000
ALLOW_SANDBOX_PROVIDER=true     # development only
```

Generate the secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"
```

Then:

```bash
npm run migrate      # applies src/db/sql/*.sql once each, checksummed
npm run seed         # demo admin + merchant, prints credentials
npm run dev          # web on :3000
npm run worker       # separate terminal: background jobs
```

The seed user is `admin@upiverify.test` / `merchant@upiverify.test` with the
password printed by the command (override with `SEED_PASSWORD`). These are
development credentials; never use them anywhere else.

To make sandbox payments visible, the demo merchant defaults to the `sandbox`
provider (because `ALLOW_SANDBOX_PROVIDER=true`). The customer page shows a
"SANDBOX — no real money" badge and a simulator link. With the sandbox
disabled, the demo merchant falls back to `manual_upi`.

### 3. Tests

```bash
createdb -h 127.0.0.1 -p 55432 -U app payment_gateway_test   # once
npm test
npm run typecheck
npx tsx -r dotenv/config scripts/smoke.ts
```

Tests use `TEST_DATABASE_URL` and truncate all tables between cases; never point
it at a database with real data.

---

## Production

### Topology

```
            TLS / reverse proxy (nginx, ALB, Caddy, …)
                         │
          ┌──────────────┴───────────────┐
          │                              │
   web process (N≥1)               worker process (1–2)
   node dist/index.js              node dist/worker-entry.js
          │                              │
          └──────────┬───────────────────┘
                     │
             managed PostgreSQL (TLS)
```

The web and worker images are the same build with different entrypoints. The
web process must have `RUN_BACKGROUND_JOBS=false`.

### Build and release

```bash
npm ci
npm run build                   # dist/
npm run migrate:prod            # one-off release step
npm run user:create:prod -- --email ops@example.com --name "Ops" --role ADMIN
# PROVISION_PASSWORD is read from the environment, never argv
node dist/index.js
node dist/worker-entry.js
```

Migrations are forward-only and checksummed. Take a backup before applying, and
run them as a single release step (not on every web boot). `GET /readyz` checks
database connectivity and the migration table.

### Environment

Use the production values from `.env.example`, in particular:

```dotenv
NODE_ENV=production
APP_URL=https://pay.example.com
COOKIE_SECURE=true
TRUST_PROXY=true                 # only if a trusted proxy terminates TLS
RUN_BACKGROUND_JOBS=false
ALLOW_SANDBOX_PROVIDER=false
PGSSLMODE=require
```

`src/config.ts` refuses to start when: `APP_URL` is not https, cookies are not
secure, the session secret is a placeholder, the sandbox provider is enabled, a
provider key is set without its webhook secret, or the OAuth redirect is not
https.

Secrets belong in a secret manager (AWS Secrets Manager, GCP Secret Manager,
Vault, Doppler, …) injected as environment variables at runtime. Do not bake
them into images.

### Database

- Managed Postgres with automated backups and PITR.
- TLS required; least-privilege role (no `SUPERUSER`, no `CREATEDB`).
- Connection limits: keep `DB_POOL_MAX` × instances below the server limit.
- Monitor: connections, slow queries on `payment_orders`/`payment_transactions`,
  table bloat on `payment_events`.
- Indexes already cover order lookup by id/token/status, event ids and
  transaction references; review `EXPLAIN` if volume grows.

### Reverse proxy

- Terminate TLS; forward `X-Forwarded-For` only from the proxy (set
  `TRUST_PROXY` accordingly).
- Set a request body limit ≥ 256 kB for `/webhooks/*` (the app enforces 256 kB).
- Do not buffer/retry webhooks with a rewritten body — signatures are computed
  on the raw bytes.
- Webhook endpoint must be publicly reachable over HTTPS and must return 2xx
  quickly; provider retries handle transient 5xx.

### Webhook registration

| Provider | URL | Secret env |
| --- | --- | --- |
| Razorpay | `https://<host>/webhooks/razorpay` | `RAZORPAY_WEBHOOK_SECRET` |
| Cashfree | `https://<host>/webhooks/cashfree` | `CASHFREE_WEBHOOK_SECRET` |

Verify with a test event from the provider dashboard; expect
`{"received":true,"outcome":"PROCESSED"|"IGNORED","duplicate":false}`.

### Worker

Run one or two worker instances. Jobs use row locks and unique keys, so
concurrent runs are safe; more than a couple of workers adds load without
benefit. The worker needs the same environment and database access as the web
process.

Monitor `reconciliation_runs` (status, checked, changed, errors) and worker
logs. A `FAILED` run means the job threw before finishing — alert on it.

### Observability

- Structured JSON logs (`src/observability/logger.ts`) with request ids; ship to
  your log platform.
- Alert on the conditions in [security.md](security.md#monitoring-for-reconciliation-failures).
- Keep `/healthz` and `/readyz` on an internal path or protect them at the
  proxy if your policy requires it.

### Scaling and availability

- The web tier is stateless apart from the database; scale horizontally behind
  the proxy.
- Session and rate-limit state live in Postgres, so instances agree.
- The provider webhook path is the critical write path: keep DB latency low and
  avoid long transactions (adapter calls already happen outside transactions).
- For multi-region, run one primary database and keep all workers in one region
  to avoid clock/window surprises.

### Secret rotation

1. **Session secret**: deploy the new value during a maintenance window; all
   users must sign in again.
2. **Encryption keys**: prepend `v2:<new>` to `TOKEN_ENCRYPTION_KEYS`, deploy,
   then re-encrypt rows (or wait for Gmail reconnects). Remove `v1` only when no
   row references it (`SELECT DISTINCT token_key_version FROM gmail_connections`).
3. **Provider keys/webhook secrets**: create new credentials in the provider
   dashboard, deploy, verify traffic, revoke the old ones.
4. **Database password**: rotate with a new role and a pool drain.

### Backup and restore

- Nightly full backup + PITR; encrypt at rest; store in a different account.
- Rehearse restoring into a staging database and running `npm run migrate:prod`
  + `GET /readyz` against it.
- `payment_transactions`, `refunds`, `audit_logs` and `payment_events` are the
  tables you cannot reconstruct from providers alone — treat them as financial
  records.

### Go-live checklist

- [ ] Production environment values set; startup guard rails pass.
- [ ] Provider accounts live, keys and webhook secrets in the secret manager.
- [ ] Webhooks registered and test events processed.
- [ ] Gmail OAuth verified (or limited to test users, documented).
- [ ] HTTPS, HSTS, secure cookies verified.
- [ ] Admin accounts behind SSO/MFA.
- [ ] Worker running; `reconciliation_runs` recorded.
- [ ] Backups + restore rehearsal done.
- [ ] Monitoring/alerting wired.
- [ ] Manual review runbook rehearsed (approve/reject, refund, reconcile).
- [ ] Rollback plan: previous image tag + forward-only migration policy.

### Rollback

Deployments are stateless; roll back the image tag. Migrations are
forward-only: if a release adds a column/table, the previous image still works
because migrations are additive. If a migration is destructive, take a backup
first and restore rather than trying to reverse it.
