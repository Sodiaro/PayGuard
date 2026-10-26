#!/usr/bin/env bash
# Provisions PayGuard's database roles and databases. Run it as a PostgreSQL superuser: the
# Compose postgres image runs it on first start of an empty volume, CI runs it against its service
# database, and an operator runs it by hand for an existing server. It is idempotent: running it
# again sets the passwords again (rotation) and changes nothing else. The application never runs
# it and never holds credentials that could.
#
#   payguard_owner     LOGIN  owns the schema; used only to apply migrations
#   payguard_runtime   group  privileges of the API and worker (granted by migrations)
#   payguard_app       LOGIN  member of payguard_runtime; the API and worker connect as it
#   payguard_operator  group  privileges of the operator CLI (granted by migrations)
#   payguard_cli       LOGIN  member of payguard_operator; the CLI connects as it
#
# None of them is a superuser or may create roles or databases, bypass row security or replicate.
#
# Environment: PAYGUARD_OWNER_PASSWORD, PAYGUARD_APP_PASSWORD, PAYGUARD_CLI_PASSWORD (required);
# PAYGUARD_DATABASES, the space-separated databases to create or adopt (default: POSTGRES_DB, or
# payguard, and payguard_test); the standard PG* variables or POSTGRES_USER to reach the server.
set -euo pipefail

: "${PAYGUARD_OWNER_PASSWORD:?PAYGUARD_OWNER_PASSWORD must be set}"
: "${PAYGUARD_APP_PASSWORD:?PAYGUARD_APP_PASSWORD must be set}"
: "${PAYGUARD_CLI_PASSWORD:?PAYGUARD_CLI_PASSWORD must be set}"
databases="${PAYGUARD_DATABASES:-${POSTGRES_DB:-payguard} payguard_test}"

run_psql() {
  # Warnings and errors only: re-running reports nothing for roles and grants that already exist.
  PGOPTIONS='-c client_min_messages=warning' psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet \
    --username "${PGUSER:-${POSTGRES_USER:-postgres}}" "$@"
}

run_psql --dbname postgres \
  -v owner_password="$PAYGUARD_OWNER_PASSWORD" \
  -v app_password="$PAYGUARD_APP_PASSWORD" \
  -v cli_password="$PAYGUARD_CLI_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I', name)
FROM (VALUES ('payguard_owner'), ('payguard_runtime'), ('payguard_app'),
             ('payguard_operator'), ('payguard_cli')) AS roles(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name)
\gexec

ALTER ROLE payguard_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  INHERIT PASSWORD :'owner_password';
ALTER ROLE payguard_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE payguard_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE payguard_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  INHERIT PASSWORD :'app_password';
ALTER ROLE payguard_cli LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  INHERIT PASSWORD :'cli_password';
GRANT payguard_runtime TO payguard_app;
GRANT payguard_operator TO payguard_cli;
SQL

for database in $databases; do
  run_psql --dbname postgres -v database="$database" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER payguard_owner', :'database')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'database')
\gexec
SELECT format('ALTER DATABASE %I OWNER TO payguard_owner', :'database')
\gexec
-- Only the owner and the two group roles may connect; nobody else may create temporary tables.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'database')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO payguard_runtime, payguard_operator', :'database')
\gexec
SQL

  # A database created before this script existed holds objects owned by whoever migrated it
  # (typically the bootstrap superuser). Hand them to the owner role so migrations can run as it.
  run_psql --dbname "$database" <<'SQL'
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT format('ALTER TABLE public.%I OWNER TO payguard_owner', c.relname) AS statement
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relowner <> 'payguard_owner'::regrole
    UNION ALL
    SELECT format('ALTER TYPE public.%I OWNER TO payguard_owner', t.typname)
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
      AND t.typowner <> 'payguard_owner'::regrole
    UNION ALL
    SELECT format('ALTER FUNCTION %s OWNER TO payguard_owner', p.oid::regprocedure)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proowner <> 'payguard_owner'::regrole
  LOOP
    EXECUTE item.statement;
  END LOOP;
END
$$;
SQL
done
