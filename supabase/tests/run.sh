#!/bin/sh
# Runs every migration and then the SQL tests.
#
#   sh supabase/tests/run.sh
#       starts a throwaway local Postgres (needs initdb / pg_ctl, Postgres 15+)
#
#   DATABASE_URL=postgresql://... sh supabase/tests/run.sh
#       uses an EMPTY database you give it (for example `supabase start` locally).
#       Never point this at your real project: the tests create and delete users.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PSQL="psql -X -q -v ON_ERROR_STOP=1"
export PGOPTIONS="-c client_min_messages=warning"

if [ -z "${DATABASE_URL:-}" ]; then
  PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
  [ -x "$PGBIN/initdb" ] || PGBIN=$(dirname "$(command -v initdb)")
  TMP=$(mktemp -d)
  AS=""
  if [ "$(id -u)" = "0" ]; then           # initdb refuses to run as root
    chown postgres "$TMP"; AS="runuser -u postgres --"
  fi
  $AS "$PGBIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
  $AS "$PGBIN/pg_ctl" -D "$TMP/data" -o "-k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
  trap '$AS "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1; rm -rf "$TMP"' EXIT
  DATABASE_URL="postgresql://postgres@/postgres?host=$TMP"
  $PSQL "$DATABASE_URL" -f "$ROOT/tests/supabase_shim.sql"
fi

for f in "$ROOT"/migrations/*.sql; do
  echo "migrate: $(basename "$f")"
  $PSQL "$DATABASE_URL" -f "$f"
done
# second run proves the migrations are safe to run again
for f in "$ROOT"/migrations/*.sql; do
  $PSQL "$DATABASE_URL" -f "$f"
done
echo "migrations: re-run OK"

for t in "$ROOT"/tests/*_test.sql; do
  echo "test: $(basename "$t")"
  OUT=$(mktemp)
  if ! PGOPTIONS="" $PSQL "$DATABASE_URL" -o /dev/null -f "$t" >"$OUT" 2>&1; then
    sed 's/^psql:[^ ]* NOTICE:  //' "$OUT"; rm -f "$OUT"
    echo "SQL TESTS FAILED"; exit 1
  fi
  sed 's/^psql:[^ ]* NOTICE:  //' "$OUT"; rm -f "$OUT"
done
echo "ALL SQL TESTS PASSED"
