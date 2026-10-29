# Testing

Four layers, each run by one command. Unit tests, integration tests and the Docker smoke test run
in CI on pushes to `main` and on pull requests; the soak test runs on demand.

| Command                | What it runs                                                                        | Needs                    |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| `npm test`             | Unit tests (`src/**/*.spec.ts`)                                                     | Nothing                  |
| `npm run test:e2e`     | Integration and HTTP tests against real PostgreSQL (`test/**/*.e2e-spec.ts`)        | The `_test` database     |
| `npm run test:soak`    | Concurrency soak with real worker processes (`test/concurrency.soak-spec.ts`)       | The `_test` database     |
| `npm run smoke:docker` | Builds the images and exercises the whole Compose stack (`scripts/docker-smoke.sh`) | Docker, Bash, Node, curl |

`npm run test:cov` adds a coverage report in `coverage/`. Static checks: `npm run lint`,
`npm run format:check`, `npm run typecheck`, `npm run prisma:validate`.

- [Unit tests](#unit-tests)
- [Integration tests](#integration-tests)
- [Test database](#test-database)
- [Concurrency soak test](#concurrency-soak-test)
- [Docker smoke test](#docker-smoke-test)
- [Continuous integration](#continuous-integration)

## Unit tests

No database. They cover:

- API keys: generation, parsing, comparison, and the guard's behaviour on every rejection path.
- Logging and configuration: log redaction, and validation of each process's settings, including
  which proxy entries are accepted and the refusal of the simulator in production.
- Key usage tracking: the per-process throttle, its memory bound, and that a failed write never
  fails authentication.
- Payments: payment and attempt transitions, retry eligibility, provider-result mapping,
  request validation through the real `ValidationPipe`, idempotency keys and fingerprints, the
  simulator (including lookups and ambiguous submissions), and controller status-code mapping.
- Processing: backoff, worker polling through failures, heartbeats, graceful shutdown waiting
  for the batch in flight, and the in-process starter honouring `OUTBOX_WORKER_ENABLED`.
- Health: queue and worker reasons, and `unavailable` when their queries fail.
- Metrics: the exposition format and that labels come only from enums.
- Rate limiting: the token bucket (with an injected clock), both guards, and client keys
  (IPv4, IPv4-mapped and IPv6 /64).
- Webhooks: signing and verification (exact bytes, tampering, wrong secret, timestamp
  tolerance at and beyond its edges, a dozen malformed headers), the event schema and its
  content fingerprint, every processing decision, and the simulator's deterministic events.
- Errors: body-parser rejections keep their status without echoing their message.
- Investigation: the diagnosis of every unresolved state from an attempt's jobs, with exhausted
  lookups flagged for an operator and never shown as resolved.

## Integration tests

Against **real PostgreSQL**, with the deployed database privileges:

- Merchants and keys: provisioning (including concurrent duplicates), revocation, expiry,
  suspension, the CLI, and checks that no key reaches logs or responses.
- Payments: asynchronous creation and every provider outcome, replays and `409` conflicts, and
  genuinely concurrent requests sharing a key (`Promise.all`).
- Outbox: atomic creation (a database trigger forces a failure mid-transaction), competing
  workers, a claim skipping a locked row instead of waiting, lease recovery after a worker
  dies, lease fencing, duplicate delivery, internal-failure backoff, dead-lettering and requeue.
- Reconciliation: every lookup result. Covers resubmission only on "not found", and recovery
  when a worker stalls after the provider processed the payment (success and decline recorded
  exactly once). Also covers a race between reconciliation and a late result, the stale-attempt
  sweep, and recovery in a fresh application instance after a restart.
- Retries: eligibility rules, the attempt limit, atomicity, key replay and conflicts, races with
  the same and with different keys, and cross-merchant `404`s.
- Isolation and integrity: cross-merchant `404`s, late-result protection, and the database
  constraints themselves.
- Rate limiting: `429` responses, the per-IP limit applying before authentication, a spoofed
  `X-Forwarded-For` being ignored without trusted proxies, and, with `TRUSTED_PROXIES`, per-client
  limits, IPv6 /64 grouping and client-prepended entries being skipped.
- Operations: a poison job parked as `DEAD` after `OUTBOX_MAX_RUNS` claims, the audit trail for
  every CLI action (and none for no-op changes), the append-only trigger, key usage recording,
  retention keeping unresolved and dead work, worker heartbeats in health and metrics, graceful
  shutdown of the real worker loop, and the standalone worker module processing a payment.
- Health with PostgreSQL unreachable: readiness `503` without leaking connection details, while
  liveness stays `200`.
- Database roles:
  - the application, the CLI and migrations connect as three different roles;
  - no role is a superuser or can create roles or databases;
  - both history tables refuse `UPDATE`, `DELETE` and `TRUNCATE` from the runtime and operator
    roles by privilege, and from the owner by trigger;
  - escalation, schema changes and disabling the triggers are refused;
  - the exact grant list is pinned;
  - every migration was applied by, and is owned by, the owner;
  - a payment's creation, processing, webhook, retry and reconciliation, and the CLI's commands,
    all work with only these privileges.
- Webhook intake: valid, wrong, missing, malformed and re-encoded signatures, stale and future
  timestamps, a merchant API key in place of a signature, re-serialized bodies, malformed JSON
  and invalid UTF-8, schema violations, oversized, compressed and non-JSON bodies (none of which
  store or queue anything), duplicate and concurrent deliveries, event-ID reuse with other
  content, a storage failure answered with `503`, the event and its job being written together
  or not at all, unknown attempts, a missing secret failing closed, and nothing sensitive in
  the logs.
- Webhook processing: success and decline, a decline after a success and a success after a
  decline (both unchanged), out-of-order processing notices, two contradictory events at once,
  another merchant's payment untouched, amount and currency mismatches and conflicting payloads
  deferred to a provider lookup (including one that cannot decide), webhooks racing
  reconciliation, a stalled worker resuming after a takeover, a failure rolled back and
  retried, lease-expiry recovery, the standalone worker, ops output, and the CLI sender.
- Payment history: the exact sequence, sources, transitions and request IDs for a direct
  success, an ambiguous outcome resolved by lookup after inconclusive ones, an accepted retry,
  and webhook evidence (applied and distrusted). A submission answer contradicting a
  webhook-recorded outcome is recorded and changes nothing, while an agreeing one adds nothing.
  Exhausted lookups end in `outbox_job.dead`, never a resolution, and resolve only through a
  requeue that is audited once even when two operators race. A stalled lookup resuming adds no
  second resolution. A failed history write rolls back the state change (and nothing reaches
  the provider). The append-only trigger and the actor constraint are enforced. The
  investigation commands' filtering, ordering, diagnoses and verdicts are checked, and they
  show no key, secret, idempotency key or fingerprint. The merchant API exposes no history.
- Scheduling with the application clock two minutes ahead of and behind PostgreSQL's: new and
  requeued work is due at once, a delayed lookup and a retry backoff still wait their full
  delay, and worker liveness is unaffected.
- Independent workers (separate connection pools and worker IDs) running their poll loops
  while payments, duplicate requests and lookups that become due arrive: every attempt is
  submitted once, looked up once and resolved once.

**Determinism.** Tests swap the provider through `createTestApp({ provider })`. The
`ScriptedProvider` test double keeps a ledger of what it "processed", can lose answers, fail or
hold a call open, and counts submissions and lookups. Tests drive the worker directly
(`processDueJobs()`), and move time by editing timestamps in the test database with its own
clock, so none of them sleep (tests of running worker loops wait for a condition, within a
deadline). Failures are injected with temporary triggers in that database. When a worker batch
handles a different number of jobs than a test expects, the failure lists both clocks and every
job's status, due time, lease and last error (`processDueJobsExpecting` in
`test/support/outbox.ts`).

## Test database

- Tests connect through three variables, and the whole suite runs with the deployed privileges:
  - `TEST_DATABASE_URL`: the runtime role, as the API and worker do;
  - `TEST_OPERATOR_DATABASE_URL`: the operator role, for CLI commands and provisioning merchants;
  - `TEST_MIGRATION_DATABASE_URL`: the schema owner.

  Tests refuse to start unless all three name the same database ending in `_test`. There is no
  fallback to the non-test variables.

- Jest's global setup applies migrations to that database as the owner (`prisma migrate deploy`)
  before any test runs. The roles must already exist; Compose provisions them on a new volume.
- Every test starts from empty tables: a single `TRUNCATE` over all application tables (which
  satisfies foreign keys) runs in `beforeEach`, after confirming the connected database is a
  `_test` one. Truncation, fault-injection triggers and rewritten timestamps use the owner's
  connection (`ownerDatabase()`), because the application's roles are rightly denied them.
- Integration test files run one at a time (`maxWorkers: 1` in `jest.e2e.config.js`), because they
  share the database. Unit tests still run in parallel.
- Locally, Compose creates `payguard_test`, and the roles, on the first start of the data volume.

## Concurrency soak test

`npm run test:soak` builds the project and runs `test/concurrency.soak-spec.ts`. That is a
functional soak, not a performance benchmark. It runs against the test database, with the same
`_test` safeguards and truncation as the integration tests, and checks behaviour under
concurrency; its timings describe the machine and run that produced them, nothing more. It:

- serves the API on a local port and starts `SOAK_WORKERS` real worker processes
  (`node dist/worker.js`);
- runs `SOAK_CLIENTS` concurrent HTTP clients for `SOAK_DURATION_SECONDS`, each making seeded
  random choices (`SOAK_SEED`) between creating payments (sometimes the same request twice at
  once), delivering signed webhooks (sometimes twice), and retrying failed payments (sometimes
  twice); the simulator loses every submission's answer and declines everything, so every
  attempt goes through reconciliation, races webhooks, and is retried up to the attempt limit;
- kills one worker with `SIGKILL` half-way and starts a replacement (`SOAK_KILL_WORKER=false`
  to skip), so work it held must be recovered through lease expiry;
- waits up to `SOAK_DRAIN_SECONDS` for every attempt and job to settle, then checks with SQL
  that each payment agrees with its latest attempt, attempt numbers are contiguous and within
  the limit, every finished attempt has exactly one resolution in its history and none was
  submitted twice, accepted retries match retry attempts, no payment belongs to the wrong
  merchant, no job is dead, nothing is unresolved, and there is exactly one payment per key and
  one stored event per acknowledged webhook;
- writes `soak-results/<time>/summary.json` (settings, request counts and status codes,
  latency p50/p95/p99 per operation, throughput, outcome counts, lease recoveries, violations)
  and worker logs, plus `outbox-diagnostics.txt` when anything failed.

```bash
SOAK_DURATION_SECONDS=120 SOAK_CLIENTS=16 SOAK_WORKERS=4 npm run test:soak
```

## Docker smoke test

`npm run smoke:docker` (`scripts/docker-smoke.sh`, Bash, needs Docker, Node and curl) builds the
images from the checkout and starts the full Compose stack as its own project
(`payguard-smoke`, ports `SMOKE_API_PORT`/`SMOKE_DB_PORT`, default 3180/5480) with generated
throwaway credentials and its own volume, so local development data is never touched. It
checks:

- the migrate job applies every migration to the fresh database;
- a payment is resolved by a signed webhook, and a second delivery is recognised as a duplicate;
- forged and unsigned webhooks get `401`, and the simulator command is refused in production;
- a payment is resolved by the reconciliation lookup in the standalone worker;
- `payment:inspect`, `payments:unresolved`, `ops:status` and `ops:metrics` agree;
- the API and worker refuse to start, with an explanation and no credentials in it, under
  `NODE_ENV=production` (simulator refused), without a provider, or without `NODE_ENV`, and the
  refused runs change nothing;
- the API and worker containers are connected as `payguard_app` only; `psql` as `payguard_app` or
  `payguard_cli` cannot delete or update history, disable a trigger or create a role; and every
  table is owned by `payguard_owner`;
- neither the webhook secret nor the API key appears in the logs.

It removes its containers, network and volume on exit, after a failure or a cancellation too,
printing the services' recent logs when it fails.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

1. **verify**: `npm ci` → `format:check` → `lint` → `typecheck` → `prisma:validate` → unit tests
   → role provisioning → `db:migrate:deploy` → `db:migrate:check` → integration tests
   (PostgreSQL 18 service container) → `build`.
2. **docker**: `npm run smoke:docker`, which builds the images and smoke-tests the whole Compose
   stack.

The soak test is not part of CI: run it on demand. Each CI step calls the same npm scripts you run
locally.
