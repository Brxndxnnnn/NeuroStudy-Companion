#!/bin/bash
# Applies db/migrations/*.sql files that are not yet recorded in the
# schema_migrations table, in filename order. Safe to run every deploy —
# already-applied files are skipped.
#
# Must be run from the repo root, with the db container already up:
#   docker compose -f compose.yaml [-f compose.prod.yaml] up -d db
#   ./db/migrate.sh
#
# .sh migrations (e.g. 002_create_bridge_user.sh) are NOT auto-applied here —
# they depend on env vars only present in the postgres container's own
# docker-entrypoint-initdb.d bootstrap and are not safely re-runnable
# (CREATE ROLE has no IF NOT EXISTS). If a new one is ever added, apply it by
# hand and record it manually; this script will just flag it.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILES="${COMPOSE_FILES:-"-f compose.yaml"}"
DB_USER="${POSTGRES_USER:-neurostudy_user}"
DB_NAME="${POSTGRES_DB:-neurostudy}"
MIGRATIONS_DIR="db/migrations"
BOOTSTRAP_FILE="013_schema_migrations_bootstrap.sql"

psql_exec() {
  docker compose $COMPOSE_FILES exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
}

psql_exec -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());" > /dev/null

# Adopting tracking against a database that already has 001_init.sql's schema
# (the clinics table) but no recorded migration history yet: this is an
# existing, already-migrated database, not a fresh one — backfill every
# migration up to and including the bootstrap file as already-applied
# instead of trying to destructively replay them.
row_count=$(psql_exec -tAc "SELECT count(*) FROM schema_migrations;" | tr -d '[:space:]')
clinics_exists=$(psql_exec -tAc "SELECT to_regclass('public.clinics') IS NOT NULL;" | tr -d '[:space:]')
if [ "$row_count" == "0" ] && [ "$clinics_exists" == "t" ]; then
  echo "Existing database with no migration history detected — backfilling up to $BOOTSTRAP_FILE without re-running them."
  for f in $(ls "$MIGRATIONS_DIR" | sort); do
    psql_exec -c "INSERT INTO schema_migrations (filename) VALUES ('$f') ON CONFLICT DO NOTHING;" > /dev/null
    if [ "$f" == "$BOOTSTRAP_FILE" ]; then
      break
    fi
  done
fi

applied_any=0
for f in $(ls "$MIGRATIONS_DIR" | sort); do
  case "$f" in
    *.sql) ;;
    *.sh)
      already=$(psql_exec -tAc "SELECT 1 FROM schema_migrations WHERE filename = '$f';" | tr -d '[:space:]')
      if [ "$already" != "1" ]; then
        echo "SKIPPING $f — .sh migrations need manual review, not auto-applied. See db/migrate.sh."
      fi
      continue
      ;;
    *) continue ;;
  esac

  already=$(psql_exec -tAc "SELECT 1 FROM schema_migrations WHERE filename = '$f';" | tr -d '[:space:]')
  if [ "$already" == "1" ]; then
    continue
  fi

  echo "Applying $f..."
  docker compose $COMPOSE_FILES exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$MIGRATIONS_DIR/$f"
  psql_exec -c "INSERT INTO schema_migrations (filename) VALUES ('$f') ON CONFLICT DO NOTHING;" > /dev/null
  echo "Applied $f."
  applied_any=1
done

if [ "$applied_any" == "0" ]; then
  echo "No new migrations to apply."
fi
