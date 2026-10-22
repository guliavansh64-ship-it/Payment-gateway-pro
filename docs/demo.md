# Running the demo

Three ways to look at the platform, fastest first. All of them run the
**sandbox (test-double) provider** — no real money, no real UPI app, no bank
credentials. Everything is labelled in the UI as sandbox.

Demo accounts (created by the seed):

| Role | Email | Password |
| --- | --- | --- |
| Merchant | `merchant@upiverify.test` | `ChangeMeNow!2026` |
| Admin | `admin@upiverify.test` | `ChangeMeNow!2026` |

Change or delete these before any shared/public deployment.

---

## 1. Hosted preview (this workspace)

Only available while the workspace sandbox is running. If you see
`502 — Sandbox not found`, the sandbox is asleep: send a message in the chat to
wake it, or use option 2/3 below.

```bash
bash scripts/demo-start.sh      # PostgreSQL + migrations + seed + web app
```

The script keeps PostgreSQL data in `.pgdata/` (gitignored) so a restart does not
lose the demo orders. It is idempotent: run it again after a pause.

---

## 2. Docker (recommended on your own machine)

Requires Docker Desktop or Docker Engine with the Compose plugin.

```bash
docker compose up --build
# open http://localhost:3000
```

What happens:

1. `db` starts PostgreSQL 16 and reports healthy.
2. `app` builds the TypeScript project, applies migrations, seeds the demo users
   if the database is empty, then starts the web server on port 3000.
3. Data lives in the `db-data` volume, so `docker compose down` keeps orders and
   `docker compose down -v` resets everything.

Useful commands:

```bash
docker compose logs -f app          # application logs
docker compose exec app node -e ""  # shell into the container image
docker compose down                 # stop, keep data
docker compose down -v              # stop and wipe data
```

The compose file is a **demo** configuration: development mode, generated
placeholders for secrets, sandbox provider enabled, background jobs in-process.
Do not deploy it to production — follow [deployment.md](deployment.md).

To expose it under a different origin (for example a tunnel or preview host):

```bash
DEMO_APP_URL=https://my-demo.example.com docker compose up --build
```

---

## 3. Local Node.js

Requires Node.js >= 20.11 and a PostgreSQL 14+ you can reach.

```bash
npm install
cp .env.example .env      # set DATABASE_URL, SESSION_SECRET, TOKEN_ENCRYPTION_KEYS
npm run migrate
npm run seed
npm run dev               # http://localhost:3000
npm run worker            # second terminal (optional)
```

See [deployment.md](deployment.md#local-development) for generating secrets.

---

## What to click

1. **Customer page** — open any order link (`/pay/PAY-…?t=…`). You get a QR, the
   payee UPI ID, the amount and the expiry. "Check payment status" asks the
   provider; the browser can never declare success.
2. **Sandbox simulator** — the link on the customer page opens
   `/sandbox/pay/…`. Pick `success`, `underpay`, `overpay`, `failure` or
   `pending`. Each scenario is delivered to the app as a *signed webhook*, the
   same path a real provider uses.
3. **Merchant dashboard** — `/dashboard`: metrics, order list, search by order
   id / UTR, order detail with status timeline and transaction evidence,
   review queue, reconciliation, Gmail status, audit log, CSV export.
4. **Admin** — `/admin`: providers and health, merchants, all review cases,
   audit log, users, security overview.
5. **API** — `POST /api/orders` with the session cookie and `x-csrf-token`
   header; see [README §8](../README.md#8-http-api).

### Scenarios worth trying

| Scenario | What to do | Expected |
| --- | --- | --- |
| Exact payment | simulate `success` | order `PAID`, source `PROVIDER_WEBHOOK` |
| Underpayment | simulate `underpay` | `REVIEW_REQUIRED`, case `AMOUNT_MISMATCH`, order not paid |
| Excess payment | simulate `overpay` | `REVIEW_REQUIRED`, never over-credited |
| Provider decline | simulate `failure` | order stays unpaid, failure recorded |
| Browser claims success | press "Check payment status" before paying | still awaiting payment |
| Manual approval | dashboard → Review → approve with a reason | `PAID` + `MANUALLY_VERIFIED` (never a fake provider reference) |
| Refund | dashboard → order → refund | provider API called; `REFUNDED` / `PARTIALLY_REFUNDED` |
| Replay a webhook | repeat the same event id | `DUPLICATE`, credited once |

## Resetting the demo

```bash
# Docker
docker compose down -v && docker compose up --build

# Local (bundled launcher)
bash scripts/demo-start.sh   # then, to wipe data:
rm -rf .pgdata && bash scripts/demo-start.sh
```
