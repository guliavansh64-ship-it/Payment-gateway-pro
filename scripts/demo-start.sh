#!/usr/bin/env bash
#
# One-command demo/preview launcher.
#
#   bash scripts/demo-start.sh
#
# Starts a local PostgreSQL (data lives in .pgdata/, bundled binaries in
# tools/pginstall/), applies migrations, seeds the demo users if needed, builds
# if dist/ is missing, and then runs the web app in the foreground.
#
# This is a DEVELOPMENT helper only: the sandbox provider is enabled, cookies
# are configured for the preview proxy, and nothing here is meant for
# production (see docs/deployment.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PGDATA="$ROOT/.pgdata"
PGPORT="${DEMO_PG_PORT:-55432}"
PGBIN="$ROOT/tools/pginstall/bin"
PGLIBS="$ROOT/tools/pgserver.libs"
if [ ! -x "$PGBIN/pg_ctl" ]; then
  PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
  PGLIBS=/tmp/pgvenv/lib/python3.11/site-packages/pgserver.libs
fi
# The bundled PostgreSQL binaries carry an RPATH for the wheel layout; point the
# loader at the matching libraries wherever they ended up.
export LD_LIBRARY_PATH="$PGLIBS:${LD_LIBRARY_PATH:-}"

log() { printf '[demo] %s\n' "$*"; }

# ---------------------------------------------------------------- postgres ---
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "initialising PostgreSQL data directory at .pgdata"
  mkdir -p "$PGDATA" && chmod 700 "$PGDATA"
  "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 >/dev/null
fi

if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  log "PostgreSQL already running on port $PGPORT"
else
  log "starting PostgreSQL on port $PGPORT"
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" \
    -o "-p $PGPORT -k $PGDATA -c listen_addresses=127.0.0.1" start >/dev/null
  for _ in $(seq 1 30); do
    "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q && break
    sleep 0.5
  done
fi

psql() { "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 "$@"; }

if ! psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'app'" | grep -q 1; then
  log "creating database role 'app'"
  psql -c "CREATE ROLE app LOGIN PASSWORD 'app' CREATEDB;"
fi
for db in payment_gateway payment_gateway_test; do
  if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    log "creating database $db"
    psql -c "CREATE DATABASE $db OWNER app;"
  fi
done

# ------------------------------------------------------------------- build ---
if [ ! -f dist/index.js ]; then
  log "building"
  npm run build >/dev/null
fi

# ------------------------------------------------------- schema + demo data ---
log "applying migrations"
npm run --silent migrate

if [ "$(node -e '
const { Client } = require("pg");
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect()
  .then(() => c.query("SELECT count(*)::int AS n FROM users"))
  .then((r) => { console.log(r.rows[0].n); return c.end(); })
  .catch(() => { console.log(0); process.exit(0); });
')" = "0" ]; then
  log "seeding demo users and merchant"
  npm run --silent seed
fi

log "starting web app on port ${PORT:-3000}"
exec node dist/index.js
