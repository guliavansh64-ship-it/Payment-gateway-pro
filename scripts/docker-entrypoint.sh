#!/bin/sh
# Container entrypoint.
#
#   docker compose up            -> migrations, seed if empty, then the web app
#   RUN_MODE=worker ...          -> the background worker instead of the web app
#
# Migrations are idempotent and checksummed; the seed only runs when the users
# table is empty, so restarts are safe.
set -eu

RUN_MODE="${RUN_MODE:-web}"

echo "[entrypoint] applying migrations"
node dist/db/migrate-cli.js

if [ "${SEED_DEMO_DATA:-true}" = "true" ]; then
  users="$(node -e '
    const { Client } = require("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.connect()
      .then(() => client.query("SELECT count(*)::int AS n FROM users"))
      .then((r) => { console.log(r.rows[0].n); return client.end(); })
      .catch(() => { console.log(0); process.exit(0); });
  ' 2>/dev/null || echo 0)"
  if [ "${users:-0}" = "0" ]; then
    echo "[entrypoint] seeding demo users and merchant"
    node dist/db/seed-cli.js || echo "[entrypoint] seed skipped"
  fi
fi

if [ "$RUN_MODE" = "worker" ]; then
  echo "[entrypoint] starting background worker"
  exec node dist/worker-entry.js
fi

echo "[entrypoint] starting web app on port ${PORT:-3000}"
exec node dist/index.js
