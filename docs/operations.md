# Operations

Running, observing and investigating PayGuard: the operator CLI, payment investigation, health
checks, metrics, the audit trail, retention, database roles and troubleshooting.

- [Operator CLI](#operator-cli)
- [Payment processing](#payment-processing)
- [Investigating a payment](#investigating-a-payment)
- [Health checks](#health-checks)
- [Metrics](#metrics)
- [Alerting recommendations](#alerting-recommendations)
- [Audit trail](#audit-trail)
- [Data retention](#data-retention)
- [Database roles](#database-roles)
- [Troubleshooting](#troubleshooting)

## Operator CLI

Merchant and key administration is done with the operator CLI, which talks to the database
directly, as the operator role (`OPERATOR_DATABASE_URL`), and is therefore not reachable over HTTP.
Locally use `npm run admin -- <command>`; with Compose use `docker compose run --rm cli <command>`.

```bash
# Create a merchant and its first key (slug defaults to one derived from the name).
npm run admin -- merchant:create --name "Acme Ltd" [--slug acme] [--key-label production] [--key-expires-at 2027-01-01T00:00:00Z]

# Issue an additional key, e.g. for rotation.
npm run admin -- key:create --merchant acme --label rotation-2026-10

# Inspect (never prints secrets).
npm run admin -- merchant:list
npm run admin -- key:list --merchant acme

# Revoke one key by id or prefix (idempotent).
npm run admin -- key:revoke --key pgsk_3f9c2a7d1b4e6f80

# Disable or re-enable every key of a merchant at once.
npm run admin -- merchant:suspend --merchant acme
npm run admin -- merchant:reactivate --merchant acme
```

New keys are printed once, on stdout only. Copy them straight into the merchant's secret store;
avoid running the CLI anywhere its output is captured into shared logs.

**Rotating a key without downtime:** `key:create` → deploy the new key to the merchant's systems →
confirm with `key:list` that the new key shows a `lastUsed` time and the old key's stops advancing
→ `key:revoke` the old key. `lastUsed` is accurate to about 15 minutes, so wait at least that long
after the last expected use before treating a key as idle.

**Responding to a leaked key:** `key:revoke` it immediately; it stops working on the next
request. `merchant:suspend` blocks all of a merchant's keys at once while you investigate.

## Payment processing

```bash
# Job counts by type and status, dead and stalled jobs, lease recoveries, attempts by status and
# failure code, oldest unresolved attempt, lookup runs, retries, settle-time p50/p95 over the last
# hour, the last error category of unfinished jobs, attempts awaiting an operator, contradicting
# provider answers, webhook events by status and result with duplicate and conflicting
# deliveries, every known worker (active, silent or stopped), and the dead jobs.
npm run admin -- ops:status

# Every unresolved attempt, oldest first, with why it is not progressing (see below).
npm run admin -- payments:unresolved [--merchant acme] [--limit 50]

# One payment: attempts, their jobs, webhook events, full history and a verdict.
npm run admin -- payment:inspect --payment <payment-id>

# Put a DEAD job back in the queue with a fresh run budget (after fixing the cause). Audited.
npm run admin -- outbox:requeue --job <job-id>
```

All figures come from the database, so they are correct across any number of API and worker
processes. Worker log lines carry `jobId`, `jobType`, `paymentId`, `attemptId`, the originating
`requestId` (or `job:<id>` for swept work), a sanitized `category`, and `providerDurationMs` for
provider calls. Provider error messages and payloads are never logged or stored.

- **A dead `RECONCILE_ATTEMPT` job** means the provider could not give a definite outcome within
  the automatic window. The payment stays `PENDING`. Confirm the attempt's state with the provider
  (by attempt ID), then requeue the job so the outcome is recorded through the normal guarded path.
- **A dead `PROCESS_ATTEMPT` job** failed internally repeatedly, or crashed its workers (see
  poison jobs in [architecture.md](architecture.md#processing-and-recovery)). Check the logs for
  its `jobId` before requeueing. The stale sweep queues a lookup for its attempt, which resubmits
  only if the provider never received it.
- **A dead `APPLY_WEBHOOK_EVENT` job** failed internally repeatedly; its event is still `RECEIVED`
  and nothing was applied. Fix the cause and requeue it. Its attempt is still covered by its own
  processing and reconciliation jobs meanwhile.
- **A webhook with `OUTCOME_CONFLICT`, `DATA_MISMATCH` or `PAYLOAD_CONFLICT`** means the provider
  said something that contradicts PayGuard's records, so nothing was changed. Compare with the
  provider by attempt ID (the event row has the attempt ID, event ID and provider reference). A
  success reported for an attempt recorded as failed needs particular care: the merchant may
  retry that payment.
- **An `attempt.result_conflict` in a payment's history** means a definite answer to a
  submission or lookup disagreed with the outcome already recorded (typically from a webhook that
  arrived first). The recorded outcome stands; investigate it like a webhook conflict.

## Investigating a payment

Every payment has an append-only history in `payment_events`, written in the same transaction as
the change or decision it describes, so it can never claim something that did not commit. It is
for operators only: the merchant API does not expose it.

| Event                      | Source                                                       | Records                                                                                                        |
| -------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `payment.created`          | `MERCHANT`                                                   | Payment and attempt #1 created `PENDING`                                                                       |
| `payment.retry_accepted`   | `MERCHANT`                                                   | `FAILED` → `PENDING` with a new attempt, and the failure it retries                                            |
| `attempt.submitted`        | `WORKER`                                                     | The attempt marked as possibly sent, just before the provider call                                             |
| `attempt.outcome_unknown`  | `WORKER`                                                     | No definite answer (or redelivered after submission); lookup scheduled                                         |
| `reconciliation.deferred`  | `WORKER`                                                     | A lookup that could not decide (still processing, unavailable, error)                                          |
| `reconciliation.scheduled` | `WORKER`                                                     | The stale sweep queued a lookup for an attempt with no live work                                               |
| `attempt.resolved`         | `PROVIDER_RESPONSE`, `PROVIDER_LOOKUP` or `PROVIDER_WEBHOOK` | The outcome, with before/after statuses, provider reference and failure code                                   |
| `attempt.result_conflict`  | `PROVIDER_RESPONSE` or `PROVIDER_LOOKUP`                     | A definite answer contradicting the recorded outcome: both, nothing changed                                    |
| `webhook.not_applied`      | `PROVIDER_WEBHOOK`                                           | A distrusted webhook (`OUTCOME_CONFLICT`, `DATA_MISMATCH`, `PAYLOAD_CONFLICT`) and whether a lookup was queued |
| `outbox_job.dead`          | `WORKER`                                                     | A job given up on: its type, last error and runs. Never a resolution                                           |
| `outbox_job.requeued`      | `OPERATOR`                                                   | An operator requeue, with the (self-declared) actor                                                            |

Each event carries the request ID that started the work, and the outbox job or webhook event
involved, so it can be joined to logs. Details hold identifiers, statuses, codes and counts:
never amounts, credentials, idempotency keys, signatures or provider payloads. A database
constraint allows an actor only on `OPERATOR` events and requires one there, so provider evidence
and human actions cannot be confused. Operator actions are still recorded in
`operator_audit_events` as well; `payment_events` places them in the payment's timeline.

`payments:unresolved` lists `PENDING` attempts with a state derived from their jobs:

| State                      | Meaning                                                                  | Operator action                       |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `in_progress`              | A worker holds one of its jobs right now                                 | None                                  |
| `awaiting_submission`      | Queued for its first submission                                          | None; check workers if it persists    |
| `submission_retrying`      | Submission failed internally (not at the provider); retried with backoff | Check logs for the job if it persists |
| `awaiting_lookup`          | The outcome is unknown; a lookup is scheduled                            | None                                  |
| `lookup_retrying`          | Lookups so far could not decide; retried with backoff                    | None; watch the provider              |
| `reconciliation_exhausted` | Lookups ran out of runs. Nothing automatic will resolve it               | Required (below)                      |
| `awaiting_sweep`           | No live job; the stale sweep queues a lookup once it is old enough       | None                                  |

Each row also counts the attempt's distrusted webhooks and contradicting answers.
`payment:inspect` shows the same diagnosis per attempt, with every job (runs, lease recoveries,
last error), every webhook event and the full history, ending with a verdict: either the
payment's final status, or which attempts are unresolved and why.

**Resolving `reconciliation_exhausted`.** There is deliberately no command that sets an outcome
by hand: a final status is only ever recorded from the provider's own answer, through the same
guarded write as every other outcome. Confirm the attempt with the provider by attempt ID, fix
whatever stopped the lookups, then `outbox:requeue` its dead `RECONCILE_ATTEMPT` job; the next
lookup records the outcome (and its history shows the requeue, by whom, then the resolution). If
the provider can never answer a lookup for it, the attempt stays `PENDING`: PayGuard has no
trustworthy evidence to resolve it with.

## Health checks

Both endpoints are public, unauthenticated and not rate-limited. Responses carry status and reason
codes only, never counts, errors or connection details.

| Check     | Endpoint           | Fails or degrades when                                                                                                                                                                      | Result               |
| --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Liveness  | `GET /health/live` | The process cannot answer HTTP at all. Never checks the database or the queue.                                                                                                              | 200 or no answer     |
| Readiness | `GET /health`      | `database`: PostgreSQL does not answer a ping.                                                                                                                                              | `down`, HTTP 503     |
| Queue     | `GET /health`      | `queue`: `backlog` (a due job has waited longer than `HEALTH_QUEUE_BACKLOG_SECONDS`), `stalled_jobs` (a lease expired that long ago and nobody reclaimed it), `dead_jobs` (any `DEAD` job). | `degraded`, HTTP 200 |
| Workers   | `GET /health`      | `workers`: `no_active_worker` (no worker on any instance heartbeated within `HEALTH_WORKER_TIMEOUT_SECONDS`).                                                                               | `degraded`, HTTP 200 |

If the queue or worker query itself fails, that check reports `unavailable`. Queue and worker
problems keep HTTP 200 deliberately: this instance can still accept payments (they are stored and
wait in the outbox), so taking it out of the load balancer would turn a processing delay into an
outage. Use liveness for restarts, readiness for routing, and alert on `degraded` separately. The
standalone worker has no HTTP endpoint; its health is the `workers` check and the metrics below,
plus the container's exit status.

## Metrics

```bash
npm run admin -- ops:metrics   # Prometheus text exposition format, on stdout
```

`ops:metrics` prints a snapshot computed from the database, so any one invocation describes the
whole system. There is no `/metrics` HTTP endpoint; to scrape it, run the command on a schedule
(for example a cron job writing to the node_exporter textfile collector). Every metric is a gauge,
and label values come only from fixed enums (`type`, `status`, `category`, `failure_code`,
`quantile`, `result`), never from IDs, event IDs, merchants or free text (nothing a webhook sender
controls becomes a label), so the series count is bounded. Values describe the rows currently
retained, so outbox counts and sums can drop after `maintenance:prune`; alert on levels and
short-window increases rather than on lifetime totals.

| Metric                                                    | Labels                     | Meaning                                                              |
| --------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `payguard_outbox_jobs`                                    | `type`, `status`           | Jobs by type and status                                              |
| `payguard_outbox_dead_jobs`                               |                            | Jobs parked as `DEAD`                                                |
| `payguard_outbox_expired_leases`                          |                            | `PROCESSING` jobs whose lease has expired                            |
| `payguard_outbox_oldest_due_job_age_seconds`              |                            | How long the oldest due job has waited                               |
| `payguard_outbox_lease_recoveries`                        |                            | Takeovers of expired leases, summed over retained jobs               |
| `payguard_outbox_unfinished_jobs_by_last_error`           | `category`                 | Unfinished jobs by sanitized last error                              |
| `payguard_reconciliation_lookup_runs`                     |                            | Lookup runs, summed over retained reconciliation jobs                |
| `payguard_payment_attempts`                               | `status`, `failure_code`   | Attempts by status and failure code (`none` when unset)              |
| `payguard_payment_attempts_unresolved`                    |                            | Attempts still `PENDING`                                             |
| `payguard_payment_attempts_oldest_unresolved_age_seconds` |                            | Age of the oldest `PENDING` attempt                                  |
| `payguard_payment_attempts_awaiting_operator`             |                            | Unresolved attempts whose lookups are exhausted                      |
| `payguard_payment_attempt_result_conflicts`               |                            | Provider answers that contradicted a recorded outcome (all time)     |
| `payguard_payment_retries`                                |                            | Accepted retry requests                                              |
| `payguard_payment_attempt_settle_seconds`                 | `quantile` (`0.5`, `0.95`) | Creation-to-outcome time of attempts settled in the last hour        |
| `payguard_workers_active`                                 |                            | Workers with a heartbeat in the last 30 s                            |
| `payguard_worker_last_heartbeat_age_seconds`              |                            | Newest heartbeat age (`-1`: no worker has ever reported)             |
| `payguard_worker_last_job_finished_age_seconds`           |                            | Time since any worker last finished a job (`-1`: never)              |
| `payguard_webhook_events`                                 | `status`, `result`         | Stored provider events by status and result (`none` until processed) |
| `payguard_webhook_duplicate_deliveries`                   |                            | Redeliveries of stored events, acknowledged as duplicates            |
| `payguard_webhook_conflicting_deliveries`                 |                            | Deliveries that reused an event ID with other content (`409`)        |

Request rates and latencies are not exported; derive them from the access log (one JSON line per
request with status and duration) or from the proxy in front of the API.

## Alerting recommendations

These are starting points, not tuned values; nothing in PayGuard sends alerts itself. Adjust them
to observed traffic.

| Condition                                                                                       | Suggested threshold  | Why                                                                    |
| ----------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `payguard_workers_active == 0`                                                                  | for 2 minutes        | Nothing is processing payments                                         |
| `payguard_outbox_dead_jobs > 0`                                                                 | immediately          | Every dead job needs an operator decision                              |
| `payguard_outbox_oldest_due_job_age_seconds`                                                    | > 120 for 5 minutes  | Workers are down, overloaded or failing                                |
| `payguard_payment_attempts_oldest_unresolved_age_seconds`                                       | > 900                | Outcomes are unknown beyond the automatic lookup window                |
| `payguard_outbox_expired_leases > 0`                                                            | for 5 minutes        | Workers are dying or hanging mid-job                                   |
| Increase in `payguard_outbox_lease_recoveries`                                                  | > 5 in 15 minutes    | Possible poison job or crash-looping worker                            |
| `payguard_payment_attempts{status="FAILED",failure_code="PROVIDER_UNAVAILABLE"}` rising         | sustained            | Provider outage                                                        |
| `payguard_payment_attempt_settle_seconds{quantile="0.95"}`                                      | > 30                 | Processing is slow                                                     |
| `GET /health` returns 503                                                                       | 2 consecutive probes | Instance cannot reach PostgreSQL                                       |
| `payguard_webhook_events{result=~"OUTCOME_CONFLICT\|DATA_MISMATCH\|PAYLOAD_CONFLICT"}` increase | > 0                  | The provider contradicts PayGuard's records; investigate each          |
| Increase in `payguard_webhook_conflicting_deliveries`                                           | > 0                  | Event IDs reused with other content: provider fault or leaked secret   |
| `payguard_webhook_events{status="RECEIVED"}`                                                    | > 0 for 10 minutes   | Stored events are not being processed                                  |
| `payguard_payment_attempts_awaiting_operator > 0`                                               | immediately          | Outcomes nothing automatic will establish; see `payments:unresolved`   |
| Increase in `payguard_payment_attempt_result_conflicts`                                         | > 0                  | The provider contradicted itself or a webhook; investigate the payment |

## Audit trail

Every operator action that changes state writes a row to `operator_audit_events`, in the same
transaction as the change: `merchant.created`, `merchant.suspended`, `merchant.reactivated`,
`api_key.issued`, `api_key.revoked`, `outbox_job.requeued` and `maintenance.pruned`. Repeating an
action that changes nothing (suspending a suspended merchant, revoking a revoked key) writes no
event. Details hold identifiers, slugs, key prefixes and labels; never secrets.

```bash
npm run admin -- audit:list [--limit 50]   # newest first, default 20, at most 200
```

- **Actor:** `PAYGUARD_OPERATOR`, or `<os user>@<host>` when unset. It is self-declared, not
  authenticated: anyone who can run the CLI can set it. It identifies who acted only as reliably as
  access to the CLI host and database is controlled.
- **Append-only, not tamper-proof:** the application's and the CLI's roles hold no `UPDATE`,
  `DELETE` or `TRUNCATE` privilege on the table, and a trigger also rejects updates and deletes by
  its owner. The schema owner or a superuser can still drop the trigger (see
  [architecture.md](architecture.md#database-roles)). For tamper evidence, ship events to an
  external, write-once store.
- Events are kept indefinitely; `maintenance:prune` never touches them.
- Provider evidence and the worker's own decisions are not operator actions and are not written
  here; they are in each payment's history (see [Investigating a payment](#investigating-a-payment)),
  whose table has the same append-only trigger and the same limits.

## Data retention

Nothing is deleted automatically. The defaults keep everything:

| Data                                                     | Retention                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Payments, attempts, idempotency keys, retry requests     | Indefinitely. They are the financial record, and deleting an idempotency key would let a replay create a second payment.                                     |
| Audit events                                             | Indefinitely, and the table rejects deletes                                                                                                                  |
| Payment history (`payment_events`)                       | Indefinitely, and the table rejects deletes. Grows by a few rows per attempt, plus one per inconclusive lookup (bounded by `OUTBOX_MAX_RUNS` per run budget) |
| Provider webhook events                                  | Indefinitely: deduplication depends on them, so deleting one would let a replayed delivery be accepted again                                                 |
| Merchants and API keys                                   | Indefinitely; merchants are suspended and keys revoked, never deleted                                                                                        |
| `COMPLETED` outbox jobs of attempts with a final outcome | Prunable on demand                                                                                                                                           |
| Worker heartbeat rows                                    | Prunable on demand                                                                                                                                           |
| `DEAD` jobs and jobs of `PENDING` attempts               | Never pruned: they are the evidence for unresolved work                                                                                                      |

```bash
npm run admin -- maintenance:prune --completed-jobs-days 30 [--workers-days 30] [--batch-size 1000]
```

The job and worker retention must be at least 7 days, deletes run in batches (default 1000 rows)
so no statement holds locks for long, and each run writes a `maintenance.pruned` audit event with
the counts. Run it manually or from a scheduler; it is idempotent.

## Database roles

What each role may do, and why, is in [architecture.md](architecture.md#database-roles).

**Provisioning.** `docker/postgres/init/01-roles-and-databases.sh` creates the roles, makes
`payguard_owner` the owner of the databases, and allows only the two groups (and the owner) to
connect. It runs as a superuser:

- Compose runs it on first start of an empty volume.
- CI runs it against its service database.
- For any other server, run it once by hand (it is idempotent):

  ```bash
  PGHOST=... PGUSER=<superuser> PGPASSWORD=... PAYGUARD_DATABASES="payguard" \
  PAYGUARD_OWNER_PASSWORD=... PAYGUARD_APP_PASSWORD=... PAYGUARD_CLI_PASSWORD=... \
    bash docker/postgres/init/01-roles-and-databases.sh
  ```

The application never holds credentials that could create roles. Migrations grant the
privileges, so a migration fails if the roles were never provisioned.

**Rotating a password.**

1. Run the script again with the new password; it sets the passwords of all three login roles.
2. Update the URL that uses the role, and restart the processes that use it.

For rotation without downtime, provision a second login role in the same group (for example
`payguard_app_2`), move the processes to it, then drop the old one. In production, store these
credentials in a secret manager, not in files.

**Upgrading an existing local volume.** A volume created before these roles existed has tables
owned by its bootstrap superuser.

1. Run the script against it, with `docker compose exec` into the `postgres` service. It creates
   the roles, hands every existing table, type and function to `payguard_owner`, and restores
   PostgreSQL's default ownership of the `public` schema, changing no data.
2. Apply the migrations as `payguard_owner`.

Alternatively, recreate the volume with `docker compose down -v`, which deletes its data.

## Troubleshooting

| Symptom                                                                       | Fix                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Missing API key`                                                         | Send `Authorization: Bearer <key>`. Keys in query strings are ignored by design.                                                                                                                                                                                                                                                                                    |
| `401 Invalid API key` with a key you just created                             | Check for truncation or extra whitespace, then `key:list` for its status and `merchant:list` for suspension. The server log names the rejection reason.                                                                                                                                                                                                             |
| `400` with `field: "Idempotency-Key"`                                         | Send an `Idempotency-Key` header of 1-255 visible ASCII characters (no spaces).                                                                                                                                                                                                                                                                                     |
| `409 Idempotency-Key has already been used...`                                | The key belongs to an earlier operation with a different request. Use a new key for a new operation, or resend the original request to read the result.                                                                                                                                                                                                             |
| `409 Payment cannot be retried: <reason>`                                     | Only `FAILED` payments with fewer than 3 attempts can be retried; a `PENDING` payment is still being processed or reconciled.                                                                                                                                                                                                                                       |
| `429 Rate limit exceeded`                                                     | Wait `Retry-After` seconds. If every client is limited together behind a proxy, list the proxy's address in `TRUSTED_PROXIES`.                                                                                                                                                                                                                                      |
| A payment stays `PENDING`                                                     | Run `payment:inspect --payment <id>` for its state and history, or `payments:unresolved` for all of them. No active worker in `ops:status` means nothing is processing (start `worker`, or set `OUTBOX_WORKER_ENABLED=true`); `reconciliation_exhausted` means the provider never gave a definite answer (see [Investigating a payment](#investigating-a-payment)). |
| `/health` shows `workers` with `no_active_worker`                             | No worker has sent a heartbeat within `HEALTH_WORKER_TIMEOUT_SECONDS`. With the API's worker disabled, check that the `worker` service is running and can reach PostgreSQL (`docker compose logs worker`).                                                                                                                                                          |
| `/health` shows `queue` with `dead_jobs`                                      | Run `ops:status` for the dead jobs, then follow [Payment processing](#payment-processing).                                                                                                                                                                                                                                                                          |
| `/health` returns 503 with `Database is unreachable`                          | Check that PostgreSQL is running and that `DATABASE_URL` matches the Compose credentials. The server log has the real error.                                                                                                                                                                                                                                        |
| `TRUSTED_PROXIES must be comma-separated IP addresses ...`                    | Use IPs, CIDR ranges with a prefix of at least 1, or `loopback`/`linklocal`/`uniquelocal`. `0.0.0.0/0` is rejected on purpose.                                                                                                                                                                                                                                      |
| `TRUST_PROXY_HOPS` has no effect                                              | It is not a PayGuard setting; use `TRUSTED_PROXIES`.                                                                                                                                                                                                                                                                                                                |
| `maintenance:prune` refuses a value                                           | Retention must be at least 7 days and the batch size 1-10000.                                                                                                                                                                                                                                                                                                       |
| Webhooks answer `503 Webhooks are not configured`                             | Set `SIMULATOR_WEBHOOK_SECRET` for the API (Compose passes it through from your shell or `.env`).                                                                                                                                                                                                                                                                   |
| Webhooks answer `401 Invalid webhook signature`                               | The server log names the reason: `signature_missing`, `signature_malformed`, `signature_mismatch`, `signature_timestamp_too_old` or `signature_timestamp_in_future`. Sign the exact bytes you send with the same secret, and check both clocks.                                                                                                                     |
| Webhooks answer `409`                                                         | The event ID was stored earlier with different content. A redelivery must carry the same event (formatting may differ); a new event needs a new ID.                                                                                                                                                                                                                 |
| `simulator:webhook` says it is disabled                                       | It refuses to run with `NODE_ENV=production`. The Compose stack runs in development: `docker compose run --rm cli simulator:webhook --attempt <id> --url http://api:3000`.                                                                                                                                                                                          |
| `PAYMENT_PROVIDER=simulator is not allowed when NODE_ENV=production`          | Intended: the simulator records payments no provider processed, and has no production override. Use `NODE_ENV=development` for local and demonstration stacks; production needs a real provider.                                                                                                                                                                    |
| `PAYMENT_PROVIDER must be one of: simulator` or `NODE_ENV must be one of ...` | Neither has a default. Set both explicitly for the API and the worker (see `.env.example`).                                                                                                                                                                                                                                                                         |
| `OPERATOR_DATABASE_URL must be a postgresql:// connection string`             | The CLI connects as the operator role and does not fall back to `DATABASE_URL`. Set `OPERATOR_DATABASE_URL`.                                                                                                                                                                                                                                                        |
| `Invalid environment configuration: ...`                                      | The listed variables are missing or malformed. Compare `.env` with `.env.example`.                                                                                                                                                                                                                                                                                  |
| `permission denied for table ...` from the app or CLI                         | It is connecting as a role without that privilege. Check that each URL uses its own role (`payguard_app`, `payguard_cli`, `payguard_owner`), and that migrations have been applied: they grant the privileges.                                                                                                                                                      |
| `role "payguard_runtime" does not exist` during migrations                    | The roles were never provisioned on this server. Run the provisioning script as a superuser (see [Database roles](#database-roles)).                                                                                                                                                                                                                                |
| `must be owner of table ...` during migrations                                | The migration runs as a role that does not own the schema, usually because the tables predate the roles. Run the provisioning script once: it hands existing objects to `payguard_owner`.                                                                                                                                                                           |
| `migration persistence is not initialized`, or every migration shown pending  | The `public` schema is not usable by `payguard_owner`, typically after `prisma migrate reset` recreated it as another user. Run the provisioning script: it restores the schema's default ownership.                                                                                                                                                                |
| Database authentication fails although the password is right                  | URL-encode special characters in the password inside the URL (e.g. `@` → `%40`).                                                                                                                                                                                                                                                                                    |
| `Refusing to run integration tests against "..."`                             | The three `TEST_*DATABASE_URL` variables must point at a database whose name ends with `_test`.                                                                                                                                                                                                                                                                     |
| `TEST_DATABASE_URL must be set to run integration tests`                      | Add `TEST_DATABASE_URL`, `TEST_OPERATOR_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` to `.env` (see `.env.example`).                                                                                                                                                                                                                                             |
| `database "payguard_test" does not exist`                                     | The init script runs only on a fresh volume. Run the provisioning script against the existing server (see [Database roles](#database-roles)); it creates missing databases. Or reset with `docker compose down -v`.                                                                                                                                                 |
| `Property 'merchant' does not exist on type 'PrismaService'`                  | The generated client is stale. Run `npm run prisma:generate`.                                                                                                                                                                                                                                                                                                       |
| `Bind for 127.0.0.1:5432 failed: port is already allocated`                   | Another PostgreSQL is running. Set `POSTGRES_HOST_PORT` (e.g. `5434`) in `.env` and update the port in every database URL.                                                                                                                                                                                                                                          |
| `EADDRINUSE` on start                                                         | Change `PORT` (local) or `API_HOST_PORT` (Compose) in `.env`.                                                                                                                                                                                                                                                                                                       |
| `ExperimentalWarning: VM Modules is an experimental feature`                  | Expected: Jest's ESM mode prints this. It is harmless.                                                                                                                                                                                                                                                                                                              |
| Prisma suggests updating to `8.0.0-rc.*`                                      | Ignore it. Prisma publishes release candidates under its `latest` tag, and this project pins the stable 7.10.1.                                                                                                                                                                                                                                                     |
| Prettier reports every file as changed on Windows                             | Line endings: `.gitattributes` enforces LF. Re-checkout, or set `git config core.autocrlf false`.                                                                                                                                                                                                                                                                   |
