#!/usr/bin/env bash
# RLS test harness for internal/integrations/neonsync/sharing_schema.sql and
# push_schema.sql.
#
# Spins up an ephemeral postgres (no volume), stubs the Neon Data API
# environment (the `authenticated` role and auth.user_id()), applies schema.sql,
# sharing_schema.sql and push_schema.sql TWICE (idempotency check), then runs
# the RLS policy suites in scripts/sharing-rls-test.sql and
# scripts/push-rls-test.sql. Exits non-zero on any failure and always tears
# the database down.
#
# Requires docker (or a compatible CLI) on PATH, or with --local the host's
# initdb and pg_ctl (e.g. Homebrew postgresql), run on a throwaway cluster
# that listens on 127.0.0.1 only.
#
# Usage: scripts/sharing-rls-test.sh [--local]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SCHEMA="$REPO/internal/integrations/neonsync/schema.sql"
SHARING="$REPO/internal/integrations/neonsync/sharing_schema.sql"
PUSH="$REPO/internal/integrations/neonsync/push_schema.sql"
SUITES=("$HERE/sharing-rls-test.sql" "$HERE/push-rls-test.sql")

if [[ "${1:-}" == "--local" ]]; then
    for bin in initdb pg_ctl psql; do
        command -v "$bin" >/dev/null 2>&1 || { echo "error: '$bin' not found on PATH" >&2; exit 127; }
    done
    DATA="$(mktemp -d)"
    PORT="${PGPORT_TEST:-55432}"
    cleanup() {
        pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
        rm -rf "$DATA"
    }
    trap cleanup EXIT

    echo "==> starting throwaway postgres ($(postgres --version)) on 127.0.0.1:$PORT"
    initdb -D "$DATA" -U postgres --auth=trust >/dev/null
    pg_ctl -D "$DATA" -w -l "$DATA/server.log" \
        -o "-c listen_addresses=127.0.0.1 -c port=$PORT -c unix_socket_directories=''" start >/dev/null
    psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -qc 'CREATE DATABASE tokify'

    psql_in() {
        psql -h 127.0.0.1 -p "$PORT" -v ON_ERROR_STOP=1 -U postgres -d tokify "$@"
    }
else
    IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"
    CONTAINER="tokify-sharing-rls-$$"
    PGPASS="test"

    DOCKER="${DOCKER:-docker}"
    command -v "$DOCKER" >/dev/null 2>&1 || { echo "error: '$DOCKER' not found on PATH" >&2; exit 127; }

    cleanup() {
        "$DOCKER" rm -f "$CONTAINER" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT

    echo "==> starting ephemeral postgres ($IMAGE) as $CONTAINER"
    "$DOCKER" run -d --rm \
        --name "$CONTAINER" \
        -e POSTGRES_PASSWORD="$PGPASS" \
        -e POSTGRES_DB=tokify \
        "$IMAGE" >/dev/null

    # psql inside the container as the superuser, reading SQL from stdin.
    psql_in() {
        "$DOCKER" exec -i -e PGPASSWORD="$PGPASS" "$CONTAINER" \
            psql -v ON_ERROR_STOP=1 -U postgres -d tokify "$@"
    }

    echo "==> waiting for postgres to accept connections"
    for _ in $(seq 1 60); do
        if "$DOCKER" exec -e PGPASSWORD="$PGPASS" "$CONTAINER" \
            pg_isready -h 127.0.0.1 -U postgres -d tokify >/dev/null 2>&1; then
            break
        fi
        sleep 0.5
    done
    "$DOCKER" exec -e PGPASSWORD="$PGPASS" "$CONTAINER" \
        pg_isready -h 127.0.0.1 -U postgres -d tokify >/dev/null 2>&1 \
        || { echo "error: postgres never became ready" >&2; exit 1; }
fi

# --------------------------------------------------------------------------
# Neon-environment stub. Emulates the pieces the Data API provides that a bare
# postgres lacks: the `authenticated` PostgREST role and auth.user_id(). Here
# auth.user_id() reads the app.user_id GUC the test suite sets per-caller.
# This stub lives ONLY in the harness — never in sharing_schema.sql.
# --------------------------------------------------------------------------
echo "==> applying Neon-environment stub"
psql_in <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
END $$;
GRANT authenticated TO postgres;   -- let the superuser SET ROLE authenticated
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.user_id() RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT current_setting('app.user_id', true) $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.user_id() TO authenticated;
SQL

# --------------------------------------------------------------------------
# Apply the schemas TWICE — they must apply cleanly on a fresh DB and again
# on top of themselves (idempotency).
# --------------------------------------------------------------------------
for pass in 1 2; do
    echo "==> applying schema.sql + sharing_schema.sql + push_schema.sql (pass $pass/2)"
    psql_in < "$SCHEMA"
    psql_in < "$SHARING"
    psql_in < "$PUSH"
done

# --------------------------------------------------------------------------
# Run the RLS assertion suite. ON_ERROR_STOP + RAISE-based asserts mean the
# first failure aborts with a non-zero exit.
# --------------------------------------------------------------------------
for suite in "${SUITES[@]}"; do
    echo "==> running $(basename "$suite")"
    psql_in < "$suite"
done

echo
echo "==> sharing RLS harness: OK"
