# Architecture

How PayGuard is structured, how a payment moves through it, and which guarantees each mechanism
provides. For HTTP contracts see [api.md](api.md); for running and investigating the system see
[operations.md](operations.md).

- [Modules and entry points](#modules-and-entry-points)
- [Payment lifecycle](#payment-lifecycle)
- [Processing and recovery](#processing-and-recovery)
- [Worker deployment](#worker-deployment)
- [Webhook processing](#webhook-processing)
- [Merchants and API keys](#merchants-and-api-keys)
- [Database roles](#database-roles)
- [Conventions](#conventions)
- [Limitations](#limitations)

## Modules and entry points

PayGuard is a **modular monolith**: one codebase and one image made of feature modules with
explicit boundaries, started through three entry points that compose different modules. Each
module owns its controllers, services and persistence code, and other modules use it only through
the providers it exports.

| Entry point         | Root module    | Contains                                                                                      |
| ------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `dist/main.js`      | `AppModule`    | HTTP API, webhook intake, guards, health; the worker too unless `OUTBOX_WORKER_ENABLED=false` |
| `dist/worker.js`    | `WorkerModule` | Outbox worker, job and webhook processors, payment provider; no HTTP server                   |
| `dist/cli/admin.js` | `AdminModule`  | Merchant, key, outbox and audit services, payment investigation, simulator webhook sender     |

```
src/
├── main.ts                 # API entry point: logger, HTTP setup, Swagger toggle, shutdown hooks
├── app.module.ts           # API root module: config + infrastructure + feature modules
├── app.setup.ts            # HTTP pipeline shared by main.ts and integration tests
├── worker.ts               # Standalone worker entry point (application context, no HTTP)
├── worker.module.ts        # Worker root module: core config + payment processing
├── audit/                  # Operator audit trail: event writer, actor resolution, recent events
├── auth/                   # Key format, authenticator, usage tracking, global guard, decorators
├── merchants/              # Merchant and key services, /v1/merchants and /v1/api-keys
├── payments/               # /v1/payments and retries, lifecycle, idempotency, currencies,
│                           # payment history writer, read-only investigation queries
│   ├── processing/         # Outbox worker, process/reconcile job handlers, in-process starter
│   └── providers/          # PaymentProvider port, the simulated provider and its webhooks
├── webhooks/               # /v1/webhooks intake: raw body, signature, event schema, inbox, and
│                           # the processor and policy the worker uses to apply stored events
├── outbox/                 # Outbox job store: enqueue, claim, fencing, heartbeats, stats, pruning
├── cli/                    # Operator CLI (admin.ts entry point, admin-cli.ts commands, metrics,
│                           # payment reports, simulator webhook sender)
├── config/                 # Environment schemas per process, validation, config modules
├── common/http/            # Error format, exception filter, request IDs, validation
├── common/logging/         # Structured logger, request context, access log
├── common/rate-limit/      # Token-bucket limiter and the per-IP / per-merchant guards
├── database/               # PrismaService (pg driver adapter) and DatabaseModule
├── health/                 # /health (database, queue, workers) and /health/live
└── generated/prisma/       # Generated Prisma client (gitignored; created by npm install)
prisma/
├── schema.prisma
└── migrations/
docker/postgres/init/       # Role and database provisioning script
test/                       # Integration and HTTP tests against real PostgreSQL, and the soak test
scripts/docker-smoke.sh     # Compose stack smoke test (npm run smoke:docker, CI)
```

Payment providers plug in as `PaymentProvider` implementations bound to the `PAYMENT_PROVIDER`
token; the payment domain depends only on that interface. `createPaymentProvider` in
`src/payments/providers/payment-provider.module.ts` selects the implementation from the
`PAYMENT_PROVIDER` setting and refuses the simulator under `NODE_ENV=production`.

PostgreSQL is the only stateful dependency. The outbox, leases, heartbeats, deduplication and
history all live in it, so enqueueing work is part of the same transaction as the change that
needs it, and there is no second system whose state can disagree with the database.

## Payment lifecycle

A **payment** is what the merchant asked for; an **attempt** is one try at processing it with a
provider. Payments and attempts are separate tables, so a payment can gain more attempts later
(retries) without ever being duplicated.

```
Payment:  PENDING ──► SUCCEEDED (terminal)
             │
             └──────► FAILED ──► PENDING   (only through an explicit retry, which adds an attempt)

Attempt:  PENDING ──► SUCCEEDED (terminal)
             └──────► FAILED    (terminal)
```

- `PENDING` means "no definite outcome yet": the attempt is queued, being processed, or awaiting
  reconciliation because the provider's answer was lost.
- Failure codes are `DECLINED` (the provider refused the payment) and `PROVIDER_UNAVAILABLE` (the
  provider refused to process anything, so the payment was not attempted). An outage is never
  recorded as a decline.
- The transition tables in `src/payments/payment-lifecycle.ts` are the only definition of allowed
  changes. Every status write is a conditional `UPDATE ... WHERE status IN (allowed sources)`
  derived from them, inside one transaction for the attempt and its payment, so a late or
  duplicate provider result cannot overwrite a terminal state.
- **Retry eligibility** (`retryEligibility()`): a `FAILED` payment with no attempt in flight,
  whose latest failure is retryable (both codes are; a decline may be resolved by the customer),
  and with fewer than 3 attempts (`MAX_ATTEMPTS_PER_PAYMENT`). Otherwise the retry is refused with
  `409` and the reason. A payment whose outcome is unknown is still `PENDING`, so it can never be
  retried into a second charge, and a `SUCCEEDED` payment has no outgoing transition at all.
- A retry never rewrites history: earlier attempts keep their `FAILED` status and failure code,
  and the payment's `failureCode` is cleared only while the new attempt is in progress.
- The database enforces the invariants as well. Amounts must be positive, and `completed_at` must
  be set exactly when an attempt is no longer `PENDING`. A failure code must be present exactly
  when an attempt is `FAILED`, and a payment can have at most one `PENDING` attempt (the partial
  unique index `payment_attempts_one_pending_per_payment`).

## Processing and recovery

The database is the source of truth for work still to do. Every attempt is processed through a
transactional **outbox** (`outbox_jobs`), drained by one or more workers.

```
POST /v1/payments ──► one transaction: payment + attempt #1 (PENDING) + PROCESS_ATTEMPT job ──► 202
                                                │
            worker claims job ──► marks attempt submitted ──► provider.processPayment()
                                                │
          definite answer ──► one transaction: attempt + payment outcome + job COMPLETED
          no answer       ──► one transaction: job COMPLETED + RECONCILE_ATTEMPT job (delayed)
                                                │
      worker claims lookup ──► provider.lookupPayment(attemptId)
          succeeded / declined ──► outcome recorded as above
          processing / unavailable / lookup error ──► retried with backoff, attempt stays PENDING
          not found (provider never received it) ──► resubmitted under the same attempt ID
```

- **Atomicity:** the payment (or retry attempt) and its job are committed in one transaction. If
  any part fails, nothing is stored and the request returns `500`. An attempt can never exist
  without the work that processes it.
- **Claiming:** workers claim due jobs with `SELECT ... FOR UPDATE SKIP LOCKED` in one short
  statement that also sets a lease (`OUTBOX_LEASE_SECONDS`) and a fresh lease token. Concurrent
  workers, on one or many instances, claim disjoint jobs, and no in-memory lock is involved.
- **Leases:** a job whose worker dies or stalls becomes claimable again when its lease expires
  (recorded as `LEASE_EXPIRED`). Every job update is fenced by the lease token, so a worker whose
  lease was taken over cannot complete or reschedule the job.
- **One clock for scheduling:** PostgreSQL's. When a job becomes due (on creation, after a
  backoff, after a requeue), when its lease expires, and whether a worker's heartbeat is recent
  are all computed with `now()` in the statement that writes them, and judged with `now()` when
  claiming or reporting. Application hosts therefore need no clock agreement with the database
  for any scheduling decision: a container VM that resumes from host sleep with a lagging clock
  cannot make new work look not yet due, or delayed work look overdue. The application's clock
  still stamps record times (`created_at`, `completed_at`), used for history and reporting only;
  the stale sweep compares an attempt's `created_at` with `now()`, so a clock difference shifts
  when it notices an attempt by that much, which is harmless because it only queues a lookup for
  attempts without live work.
- **No transaction spans a provider call.** Provider calls have a 10 s timeout. The outcome and the
  job's completion are written in the same transaction, so a job is never marked done before its
  result is stored.
- **No blind resubmission:** before the first provider call the attempt is marked `submitted_at`.
  A redelivered job (after a crash or an expired lease) for an attempt that may already have been
  submitted is handed to reconciliation instead of being sent again. A new submission happens
  only when the provider's lookup says it has no record of the attempt, and then under the same
  attempt ID, which is the provider-side idempotency reference.
- **Unknown outcomes** (timeout, thrown error, unrecognised answer) never fail an attempt. The
  attempt stays `PENDING` and is looked up after `RECONCILIATION_DELAY_SECONDS`. Lookups that do
  not give a definite answer are retried with exponential backoff (2 s doubling, capped at
  `OUTBOX_BACKOFF_MAX_SECONDS`).
- **Bounded retries:** each job has `OUTBOX_MAX_RUNS` runs; internal failures (for example the
  database being briefly unreachable) also consume runs. A job that runs out becomes `DEAD`, but
  it is never silently dropped. If it was a lookup, the attempt and payment stay `PENDING`: the
  outcome is unknown, so it is not reported as failed. Dead jobs are reported by `/health`
  (`degraded`) and by `ops:status`, and can be requeued by an operator.
- **Poison jobs:** a claim counts as a run even if the worker then crashes or hangs before
  rescheduling. A job that keeps killing or stalling its workers is claimed again after each lease
  expiry; once it has been claimed more than `OUTBOX_MAX_RUNS` times it is parked as `DEAD`
  (`lastError: LEASE_EXPIRED`) without being handled again. Each such takeover is counted in
  `lease_recoveries`.
- **Stale sweep:** every 30 s the worker queues a lookup for any `PENDING` attempt older than
  `RECONCILIATION_DELAY_SECONDS` that has no live job (for example after its processing job
  died). Attempts that already have a lookup job, including a dead one, are left visible rather
  than looped.
- **Duplicates are harmless:** at most one job of each type exists per attempt (a unique
  constraint), a job for an attempt that already has an outcome completes without calling the
  provider, and outcome writes are conditional on the attempt still being `PENDING`. When
  reconciliation and a late result race, exactly one is applied. A definite answer that arrives
  after the outcome was recorded is compared with it: agreement is ignored, contradiction is
  recorded as `attempt.result_conflict` and logged as an error, and neither changes the outcome.
- **History:** each of these steps (submission, unknown outcome, deferred lookup, resolution and
  the evidence behind it, job given up) is written to the payment's history in the transaction
  that makes it; see [Investigating a payment](operations.md#investigating-a-payment).
- **Shutdown:** on SIGTERM a worker stops polling, waits for the batch in flight, marks itself
  stopped, and only then is the database pool closed. A process killed outright leaves its claimed
  jobs to be recovered when their leases expire.

### What is and is not guaranteed

The system does not claim exactly-once external processing. Each mechanism covers a specific
failure:

- Database uniqueness prevents duplicate payments, attempts, retries and jobs.
- The outbox guarantees that every accepted attempt is processed at least once, even across
  crashes.
- The `submitted_at` marker and lookups prevent a lost answer from turning into a second
  submission.
- The stable attempt ID lets a provider deduplicate any resubmission that still happens.

Together these give at-most-one charge per attempt only if the provider honours its idempotency
key and answers lookups consistently once a submission's timeout has passed. The simulator
behaves that way; a real provider must be verified to.

## Worker deployment

The same worker code runs in one of two places:

| Mode                 | How                                                                                                                  | Use when                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| In-process (default) | `OUTBOX_WORKER_ENABLED=true`: each API process also polls the outbox                                                 | Local development, single-instance deployments |
| Standalone           | `node dist/worker.js` (`npm run start:worker`) on dedicated processes, with `OUTBOX_WORKER_ENABLED=false` on the API | Production: Docker Compose runs it this way    |

- **Why standalone in production:** a backlog or slow provider then cannot take CPU, event-loop
  time or database connections from HTTP traffic. Workers and API instances scale and restart
  independently, and a crashing worker does not take the API down. The worker process has no HTTP
  server, loads no HTTP, auth or rate-limit code, and validates only its own settings.
- **Why the in-process default stays:** it is one process to run, and correctness does not depend
  on the choice. Claiming, leases and fencing work the same with any number of workers in any mix
  of processes, so both modes can even run at once during a migration.
- **Heartbeats:** every worker writes a row in `outbox_workers` (`<host>:<pid>:<random>`) when it
  starts, about every 10 s, and when it stops. `/health` and `ops:status` read these rows, so they
  report workers on every instance, not only the one answering.
- **Graceful stop:** give a worker more time than its slowest batch. Provider calls time out after
  10 s; Compose uses `stop_grace_period: 30s`. Anything still unfinished when the process is killed
  is recovered through lease expiry.

## Webhook processing

A provider notifies PayGuard of outcomes by webhook. PayGuard treats each one as a signed claim
about an attempt, not as permission to set a payment's state: it authenticates the bytes, stores
the event, acknowledges it, and applies it later through the outbox, under the same lifecycle
guards as every other outcome. The request format, signature scheme and responses are in
[api.md](api.md#provider-webhooks).

**Storage and deduplication.** Accepted events are stored in `provider_webhook_events`, unique on
`(provider, event_id)`, with only their validated fields (never the raw body or signature), a
SHA-256 hash of their canonical content, the signed delivery time, and counters of duplicate and
conflicting deliveries. The hash covers meaning, not formatting, so a redelivery with different
key order or a new signature is still a duplicate. Concurrent deliveries of one event serialize
on the unique index: one is stored, the others are answered as duplicates. An invalid delivery
stores nothing. If the event or its job cannot be written, neither is, and the provider gets a
`503` to retry; an acknowledged event therefore always has its processing queued.

**Processing.** Each stored event gets an `APPLY_WEBHOOK_EVENT` outbox job, claimed, leased,
fenced, retried and dead-lettered like any other job, by whichever worker runs. The job locks the
event row, decides, records the result and completes in one transaction, so a redelivered job,
a second worker or a crash part-way through never applies an event twice: a failed run leaves
the event `RECEIVED` and the payment untouched.

| Result             | When                                                                           | Effect                                        |
| ------------------ | ------------------------------------------------------------------------------ | --------------------------------------------- |
| `APPLIED`          | Terminal event for a `PENDING` attempt whose amount and currency match         | Outcome recorded through the lifecycle guards |
| `ALREADY_APPLIED`  | The attempt already has this outcome (from its own submission or a lookup)     | None                                          |
| `NO_ACTION`        | `payment.processing`, in any state                                             | None                                          |
| `OUTCOME_CONFLICT` | The attempt already has a different outcome or provider reference              | None; logged as an error for investigation    |
| `DATA_MISMATCH`    | Amount or currency differs from the payment                                    | None; reconciliation lookup queued if pending |
| `PAYLOAD_CONFLICT` | Its event ID was redelivered with different content before it was processed    | None; reconciliation lookup queued if pending |
| `UNKNOWN_ATTEMPT`  | No attempt of this provider has that ID (recorded at intake; no job is queued) | None                                          |

- **Out of order and late events cannot regress a payment.** Outcomes are only ever written by
  the conditional updates in `applyAttemptResolution`, the same ones submissions and lookups use,
  and they only move an attempt out of `PENDING`. A late `payment.processing` changes nothing;
  a decline after a recorded success, or a success after a recorded decline, is an
  `OUTCOME_CONFLICT`. Event timestamps are stored but never used to decide.
- **Racing writers.** A webhook and a reconciliation lookup (or two contradictory webhooks) that
  race for one attempt are serialized by the attempt row's update: the first outcome wins, and
  the webhook is then classified against it. Payment and attempt always agree.
- **Ambiguous events defer to the provider.** When an event cannot be trusted (`DATA_MISMATCH`,
  `PAYLOAD_CONFLICT`) and the attempt is still pending and was submitted, a `RECONCILE_ATTEMPT`
  job is queued and the provider's lookup decides. If the lookup cannot establish the outcome
  either, the attempt stays `PENDING` under the usual reconciliation backoff and, eventually, an
  operator. Unsubmitted attempts are left to their own processing job.
- **Conflicting deliveries.** A delivery that reuses an event ID with different content is
  rejected with `409`, never stored, and counted on the original event, which is then distrusted
  if it has not been processed yet.
- Webhook outcomes are provider facts, not operator actions, so they are not written to the
  operator audit trail; `provider_webhook_events` is their record.

## Merchants and API keys

### Data model

| Table               | Purpose and notable constraints                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merchants`         | UUIDv7 `id`, unique `slug`, `name`, `status` (`ACTIVE`/`SUSPENDED`), timestamps. The unique slug is the provisioning idempotency key: a retried or concurrent `merchant:create` fails instead of creating a duplicate. |
| `merchant_api_keys` | UUIDv7 `id`, `merchant_id` (indexed, `ON DELETE RESTRICT`), unique `prefix`, `secret_hash` (`bytea`), optional `label` and `expires_at`, `revoked_at`, `last_used_at`, `created_at`.                                   |

- **Several keys per merchant.** Each key is revoked or expires on its own, which makes zero-downtime
  rotation possible.
- **Revocation is a timestamp, not a status.** It records when the key stopped working, and it is
  one-way: a revoked key is never reactivated; issue a new one instead.
- **Merchants are suspended, never deleted.** `RESTRICT` keeps key history intact for audit, and
  suspension disables every key at once while keeping them for reactivation.
- **The database enforces the hashing rule.** A `CHECK (octet_length(secret_hash) = 32)`
  constraint means only a SHA-256 digest can be stored, so a plaintext key cannot end up in that
  column through a bug or a manual insert.

### Key format and verification

```
pgsk_3f9c2a7d1b4e6f80_Jm2Qx...(43 characters)
^^^^ ^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^
type lookup prefix    secret: 32 random bytes, base64url
     (8 random bytes, hex; stored in plaintext)
```

1. The `pgsk_` marker makes leaked keys easy to spot, for people and for secret scanners.
2. Both parts come from `crypto.randomBytes`. The prefix is unique and non-secret; it locates the
   key record with one indexed lookup.
3. Only `SHA-256(secret)` is stored. A slow password hash (bcrypt, argon2) protects
   low-entropy, human-chosen passwords from offline guessing. A 256-bit random secret cannot be
   guessed either way, so a slow hash would only add CPU cost to every request.
4. Verification compares digests with `crypto.timingSafeEqual`. Unknown prefixes are still hashed
   and compared against a placeholder, so timing does not reveal which prefixes exist.
5. Every rejection returns the same response (see [api.md](api.md#authentication)); the specific
   reason and the non-secret prefix go to the server log only.
6. The plaintext key exists only in memory during issuance and in the CLI output. It is never
   stored, logged or returned again.
7. **Usage is recorded approximately.** A successful authentication sets `last_used_at`, but each
   API process writes it at most once per key every 15 minutes, and only when the stored value is
   older than that. So the value is accurate to about 15 minutes, costs at most one small `UPDATE`
   per key per window, and is never written on rejected requests. A failed write is logged and
   does not fail the request. It is shown by `key:list` and `GET /v1/api-keys`.

### Authentication in the application

- `ApiKeyGuard` is registered globally (`APP_GUARD`), so every route requires a key unless it is
  marked `@Public()`. Only the health and webhook controllers are public; Swagger UI is served
  outside the Nest router.
- Controllers get the caller from `@CurrentMerchant()`, which returns `{ merchantId, apiKeyId }`
  set by the guard. **Never take a merchant ID from the path, query, headers or body.** Services
  scope every query by that `merchantId`, so another merchant's resource behaves exactly like one
  that does not exist (404). `GET /v1/api-keys/:id` is the reference implementation.
- There are deliberately no HTTP endpoints for registering merchants or managing keys: the
  operator CLI does that, as its own database role (see [operations.md](operations.md#operator-cli)).

## Database roles

Each process connects with only the privileges it needs. None of these roles is a superuser, can
create roles or databases, replicate, or bypass row security:

| Role                           | Kind                         | Used by                            | Can                                                                                                                        |
| ------------------------------ | ---------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `payguard_owner`               | login                        | `npm run db:migrate:*`, `migrate`  | Own the schema and change it. Nothing else should connect as it                                                            |
| `payguard_runtime`             | group                        | API and worker, via `payguard_app` | Read what the application serves; insert payments, attempts, jobs, events; update only the columns its state changes touch |
| `payguard_operator`            | group                        | CLI, via `payguard_cli`            | Provision merchants and keys, inspect everything, requeue and prune jobs, append audit and history events                  |
| `payguard_app`, `payguard_cli` | login, members of the groups | the processes above                | Nothing directly                                                                                                           |

What the roles cannot do is the point:

- **History stays append-only by privilege.** Neither the runtime nor the operator role holds
  `UPDATE`, `DELETE` or `TRUNCATE` on `payment_events` or `operator_audit_events`. The runtime
  role cannot read or write the audit trail at all.
- **No escalation.** Neither role can alter or drop the append-only triggers, set
  `session_replication_role`, create tables, or grant itself anything.
- **The runtime role is narrow.** It cannot delete any row or change amounts, ownership, keys or
  merchant status.
- **The operator role is narrow too.** It cannot change payments or attempts.

Privileges are granted by migrations (`20261026120000_runtime_and_operator_privileges`), so they
travel with the schema, and `test/database-privileges.e2e-spec.ts` checks every one of these
against PostgreSQL and pins the exact grant list. **Every migration that adds a table must grant on
it**; the privilege test fails otherwise. Provisioning and password rotation are in
[operations.md](operations.md#database-roles).

**What this does not protect against.** The schema owner can still disable the append-only
triggers or rewrite history. So can any superuser or database administrator. The roles stop the
application, and anyone holding its or the CLI's credentials, from doing so. They do not make the
history tamper-proof. Keep owner and superuser credentials out of every running process, and ship
the history to write-once storage if tamper evidence is required.

## Conventions

- **Layers.** Controllers handle HTTP only: routing, DTO validation and status codes. Services
  hold the logic and throw domain errors (e.g. `MerchantNotFoundError`) that controllers and the
  CLI translate. Persistence goes through `PrismaService`.
- **Configuration.** Each entry point validates only its own settings, through the classes in
  `src/config/environment.ts`. Read config through `ConfigService`, never through `process.env`.
  To add a variable, declare it on the narrowest class that needs it and in `.env.example`.
- **Versioning.** Business endpoints are served under `/v1/...`. Operational endpoints opt out
  with `VERSION_NEUTRAL`.
- **Validation.** A global `ValidationPipe` uses `whitelist` and `forbidNonWhitelisted`, so
  properties not declared on the DTO are rejected rather than silently dropped.
- **Errors.** Every error response has one shape (see [api.md](api.md#errors)). Unexpected errors
  become a generic 500 with the stack trace logged server-side.
- **Request bodies.** Every route parses JSON except `/v1/webhooks/*`, which receives raw bytes
  (limit 64 KiB) because its signature covers the exact bytes sent.
- **HTTP security.** Helmet sets its default headers (CSP, HSTS, `nosniff`, frame options) and
  removes `X-Powered-By`. CORS is off unless `CORS_ALLOWED_ORIGINS` lists exact origins: secret
  keys belong on merchants' servers, not in browsers.
- **Logging.** One JSON object per line outside development, built on Nest's `ConsoleLogger`
  (no extra dependency). Every line logged during a request carries `requestId` and, once
  authenticated, `merchantId` (via `AsyncLocalStorage`). Each request gets one access-log line
  (method, path without query, status, duration). Headers and bodies are never logged.
  Sensitive keys (`authorization`, `cookie`, `password`, `secret`, `token`, ...) are masked, and
  any string shaped like a PayGuard key is replaced with `pgsk_[REDACTED]` in messages, values and
  stack traces. Successful health checks are not access-logged.

## Limitations

- **Simulated payments only, so no production deployment.** There is no real provider integration,
  card handling, capture, refund or payout. The simulator is refused under `NODE_ENV=production`,
  so the API and worker cannot run in production until a real provider is added. A real
  `PaymentProvider` would need at least:
  - an idempotency key per submission (the attempt ID) that the provider honours across retries;
  - a lookup by that key which, once a submission's timeout has passed, answers consistently and
    distinguishes "never received" from "still processing";
  - a mapping of every provider response to `succeeded`, `declined`, `unavailable` (nothing was
    attempted) or unknown, where anything not clearly one of the first three is unknown;
  - timeouts shorter than `OUTBOX_LEASE_SECONDS` and the stop grace period;
  - credentials from a secret store, and no raw provider error or payload in logs;
  - its own webhook endpoint and verifier, following the provider's documented signature scheme,
    event IDs and event types, plugged into the existing intake, deduplication and processing;
    and confirmation that its events echo the attempt ID and the charged amount and currency;
  - PCI DSS scope review before any card data could pass through the system.
- **No exactly-once guarantee; at most one charge per attempt depends on the provider.** See
  [What is and is not guaranteed](#what-is-and-is-not-guaranteed).
- **Automatic reconciliation is bounded.** After `OUTBOX_MAX_RUNS` inconclusive lookups the
  payment stays `PENDING` and needs an operator. The window is about 13 minutes with the defaults.
- **The in-process worker shares the API process** (the default outside Compose). A heavy backlog
  then competes with HTTP traffic; run the standalone worker in production.
- **No notifications to merchants.** Provider webhooks come in, but nothing goes out: merchants
  poll `GET /v1/payments/:id` for outcomes.
- **Webhook secrets cannot be rotated without a gap.** One secret is verified at a time, so
  changing it must coincide with the sender's change; deliveries rejected meanwhile are retried
  by the sender. The secret is shared with the operator CLI's simulator sender.
- **Webhook timestamps rely on clocks.** Server and sender clocks must agree within
  `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`; deduplication still covers replays inside that window.
  This is the only place host clock agreement matters; job scheduling uses PostgreSQL's clock.
- **No load benchmark.** The soak test checks correctness under concurrency on one machine and
  one database; capacity has not been measured.
- **Conflicts need a person.** Distrusted webhooks and contradicting provider answers are
  recorded and logged, not resolved: a final outcome is never changed automatically, even when
  the provider later reports a different one, and there is no command to change one by hand.
- **No manual resolution without the provider.** An attempt is resolved only by a provider
  answer. One the provider can never confirm stays `PENDING` and visible indefinitely.
- **History is operator-only and not tamper-proof.** Merchants cannot see `payment_events`. Like
  the audit trail, it is append-only by privilege for the application and the CLI, but the schema
  owner and superusers can still change it. Refused retries change nothing and are not recorded
  (the merchant gets the `409` and reason).
- **Retention is manual.** Payments, attempts, idempotency keys, audit and webhook events grow
  without bound by design; only completed outbox jobs and worker rows can be pruned, and only
  when an operator runs `maintenance:prune`. There is no archiving.
- **Rate limits are per process**, reset on restart, and depend on `TRUSTED_PROXIES` listing
  exactly the real proxies.
- **Idempotency keys never expire**, and a replay returns the current payment state rather than a
  stored copy of the first response.
- **Key usage is approximate** (to about 15 minutes per API process), and nothing flags keys that
  have been unused for a long time. Expiry is enforced, but nothing alerts before a key expires.
- **The audit actor is self-declared.** The CLI authenticates nobody: whoever holds the operator
  role's credentials is an administrator.
- **No built-in metrics endpoint or alerting.** Metrics are a CLI snapshot for an external
  scraper; the alerting thresholds in [operations.md](operations.md#alerting-recommendations) are
  untested suggestions.
- **The standalone worker has no health endpoint.** Its liveness is the process itself plus the
  heartbeat-based `workers` check; a worker that is alive but wedged inside one batch shows up as
  a stale heartbeat, not a failed probe.
- **HTTPS is assumed to terminate in front of the API.** HSTS is sent, but the app itself serves
  plain HTTP.
- **Swagger UI under Helmet's CSP** was checked statically (no inline scripts, all assets
  same-origin), not in a browser.
