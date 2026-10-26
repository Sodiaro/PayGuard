#!/usr/bin/env bash
# End-to-end smoke test of the Compose stack: a fresh PostgreSQL with provisioned roles, the migrate
# job, the API, the standalone worker and the operator CLI, built from this checkout. It runs as its own Compose project with generated
# credentials, its own ports and its own volume, so local development data is never touched, and
# it removes everything it created on exit, including after a failure.
#
#   bash scripts/docker-smoke.sh            (SMOKE_API_PORT, SMOKE_DB_PORT, SMOKE_PROJECT override)
set -euo pipefail

project="${SMOKE_PROJECT:-payguard-smoke}"
api="http://127.0.0.1:${SMOKE_API_PORT:-3180}"

random_hex() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }

# Generated for this run only; nothing here is a real secret.
export POSTGRES_USER=postgres POSTGRES_DB=payguard
export POSTGRES_PASSWORD="smoke-$(random_hex 12)"
export PAYGUARD_OWNER_PASSWORD="smoke-$(random_hex 12)"
export PAYGUARD_APP_PASSWORD="smoke-$(random_hex 12)"
export PAYGUARD_CLI_PASSWORD="smoke-$(random_hex 12)"
export SIMULATOR_WEBHOOK_SECRET="smoke-$(random_hex 24)"
export API_HOST_PORT="${SMOKE_API_PORT:-3180}" POSTGRES_HOST_PORT="${SMOKE_DB_PORT:-5480}"
# Every submission's answer is lost: one payment is resolved by webhook before its lookup is due,
# the other by the reconciliation lookup.
export PAYMENT_SIMULATOR_OUTCOME=SUCCEEDED PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS=true
export RECONCILIATION_DELAY_SECONDS=15
export SWAGGER_ENABLED=false CORS_ALLOWED_ORIGINS= TRUSTED_PROXIES=

compose() { docker compose -p "$project" "$@"; }
# The CLI runs in its own container with the operator role's credentials.
cli() { compose run --rm --no-deps -T cli "$@"; }
# psql as one of the application's roles, inside the postgres container.
sql_as() {
  local role=$1 password=$2
  shift 2
  compose exec -T -e PGPASSWORD="$password" postgres \
    psql -h 127.0.0.1 -U "$role" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At "$@"
}
json() { node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).$1"; }
step() { echo "== $*"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "Smoke test failed; recent service logs:" >&2
    compose logs --no-color --tail=150 >&2 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
# Cancellation (Ctrl-C, a cancelled CI job) also goes through cleanup.
trap 'exit 130' INT TERM

# Polls until a command succeeds, up to a number of seconds.
wait_for() {
  local seconds=$1 description=$2
  shift 2
  for _ in $(seq "$seconds"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out after ${seconds}s waiting for: $description"
}

payment_status() {
  curl -fsS -H "Authorization: Bearer $key" "$api/v1/payments/$1" | json status
}
payment_is() { [ "$(payment_status "$1")" = "$2" ]; }

step "Building and starting a fresh stack ($project)"
compose up -d --build
wait_for 90 "API liveness" curl -fsS "$api/health/live"

step "Migrations applied to the fresh database"
expected=$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l)
applied=$(compose logs --no-color migrate | grep -c "Applying migration" || true)
[ "$applied" -eq "$expected" ] || fail "applied $applied migrations, expected $expected"
compose logs --no-color migrate | grep -q "All migrations have been successfully applied" ||
  fail "migrate job did not finish"

step "Provisioning a merchant"
key=$(cli merchant:create --name "Smoke Ltd" | grep -oE 'pgsk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}')
[ -n "$key" ] || fail "no API key issued"

create_payment() {
  curl -fsS -X POST "$api/v1/payments" \
    -H "Authorization: Bearer $key" -H "Idempotency-Key: $1" \
    -H 'Content-Type: application/json' -d '{"amount":250000,"currency":"NGN"}'
}

step "Payment resolved by webhook, with a duplicate delivery"
first=$(create_payment smoke-webhook)
first_id=$(echo "$first" | json id)
first_attempt=$(echo "$first" | json 'attempts[0].id')
cli simulator:webhook --attempt "$first_attempt" --url http://api:3000 | grep -q "HTTP 202 accepted" ||
  fail "webhook not accepted"
cli simulator:webhook --attempt "$first_attempt" --url http://api:3000 | grep -q "HTTP 200 duplicate" ||
  fail "duplicate webhook not recognised"
wait_for 30 "webhook payment SUCCEEDED" payment_is "$first_id" SUCCEEDED
cli payment:inspect --payment "$first_id" | grep -qE 'PROVIDER_WEBHOOK +attempt\.resolved' ||
  fail "webhook resolution missing from history"

step "Forged and unsigned webhooks rejected; simulator refused in production"
forged=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$api/v1/webhooks/simulator" \
  -H 'Content-Type: application/json' \
  -H "X-Simulator-Signature: t=$(date +%s),v1=$(random_hex 32)" -d '{"id":"evt_forged00000000"}')
[ "$forged" = 401 ] || fail "forged webhook answered $forged"
unsigned=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$api/v1/webhooks/simulator" \
  -H 'Content-Type: application/json' -d '{}')
[ "$unsigned" = 401 ] || fail "unsigned webhook answered $unsigned"
if compose run --rm --no-deps -T -e NODE_ENV=production cli \
  simulator:webhook --attempt "$first_attempt" --url http://api:3000 >/dev/null 2>&1; then
  fail "simulator command ran under NODE_ENV=production"
fi

step "Payment resolved by the reconciliation lookup"
second_id=$(create_payment smoke-lookup | json id)
[ "$(payment_status "$second_id")" = PENDING ] || fail "second payment not PENDING"
wait_for 60 "reconciled payment SUCCEEDED" payment_is "$second_id" SUCCEEDED
cli payment:inspect --payment "$second_id" | grep -qE 'PROVIDER_LOOKUP +attempt\.resolved' ||
  fail "lookup resolution missing from history"

step "Operational state"
cli payments:unresolved | grep -qx "No unresolved attempts." || fail "unresolved attempts remain"
status=$(cli ops:status)
echo "$status" | grep -qE 'PROCESSED +APPLIED +1' || fail "webhook result not in ops:status"
echo "$status" | grep -qE 'Awaiting an operator: +0' || fail "attempts awaiting an operator"
echo "$status" | grep -qE 'active +heartbeat' || fail "no active worker reported"
cli ops:metrics | grep -q '^payguard_workers_active 1$' || fail "metrics do not show the worker"

step "Production configuration fails closed before any work"
payments_before=$(sql_as payguard_cli "$PAYGUARD_CLI_PASSWORD" -c 'SELECT count(*) FROM payments')
# refuses <service> <expected message> <docker compose run -e options...>
refuses() {
  local service=$1 expected=$2
  shift 2
  local output
  if output=$(compose run --rm --no-deps -T "$@" "$service" 2>&1); then
    fail "$service started with: $*"
  fi
  grep -qF "$expected" <<<"$output" || fail "$service did not explain its refusal ($*)"
  if grep -qF "$PAYGUARD_APP_PASSWORD" <<<"$output"; then fail "$service printed a credential"; fi
}
simulator_refused='PAYMENT_PROVIDER=simulator is not allowed when NODE_ENV=production'
refuses api "$simulator_refused" -e NODE_ENV=production
refuses worker "$simulator_refused" -e NODE_ENV=production
refuses api 'PAYMENT_PROVIDER must be one of: simulator' -e PAYMENT_PROVIDER=
refuses worker 'PAYMENT_PROVIDER must be one of: simulator' -e PAYMENT_PROVIDER=
refuses worker 'NODE_ENV must be one of the following values' -e NODE_ENV=
[ "$(sql_as payguard_cli "$PAYGUARD_CLI_PASSWORD" -c 'SELECT count(*) FROM payments')" = "$payments_before" ] ||
  fail "a refused process changed payments"

step "Least-privilege database roles"
connected=$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c \
  "SELECT string_agg(DISTINCT usename, ',' ORDER BY usename) FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid()")
[ "$connected" = payguard_app ] || fail "API and worker connect as: $connected"
for statement in 'DELETE FROM payment_events' "UPDATE operator_audit_events SET actor = 'x'" \
  'ALTER TABLE payment_events DISABLE TRIGGER payment_events_append_only' 'CREATE ROLE intruder'; do
  for role in payguard_app:"$PAYGUARD_APP_PASSWORD" payguard_cli:"$PAYGUARD_CLI_PASSWORD"; do
    if output=$(sql_as "${role%%:*}" "${role#*:}" -c "$statement" 2>&1); then
      fail "${role%%:*} was allowed: $statement"
    fi
    grep -qE 'permission denied|must be owner' <<<"$output" || fail "unexpected error: $output"
  done
done
owners=$(sql_as payguard_owner "$PAYGUARD_OWNER_PASSWORD" -c \
  "SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname = 'public'")
[ "$owners" = payguard_owner ] || fail "tables owned by: $owners"
step "No secrets in the logs"
logs=$(compose logs --no-color api worker)
if grep -qF "$SIMULATOR_WEBHOOK_SECRET" <<<"$logs"; then fail "webhook secret logged"; fi
if grep -qF "$key" <<<"$logs"; then fail "API key logged"; fi

echo "PASS: Docker smoke test"
