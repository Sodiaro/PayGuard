# PayGuard

Payment processing API focused on transaction reliability: idempotent payment creation, an
explicit payment/attempt lifecycle, and merchant isolation, built with NestJS, PostgreSQL and
Prisma.

- Merchant accounts with hashed, revocable API keys and an operator CLI for administration
- `POST /v1/payments` with database-enforced idempotency and safe handling of concurrent requests
- Payments and provider attempts modelled separately, with every status transition defined in one
  state machine, and explicit, idempotent retries of failed payments
- Durable processing through a PostgreSQL-backed outbox: work survives crashes and restarts,
  ambiguous provider outcomes are reconciled by lookup instead of being guessed or resubmitted
- A provider interface with a deterministic simulated provider
- Signed provider webhooks, stored before they are acknowledged, deduplicated by event ID and
  applied asynchronously through the same outbox and lifecycle guards, so duplicate, late,
  concurrent and out-of-order deliveries cannot corrupt a payment
- A worker that runs inside the API or as its own process, with heartbeats, explicit health
  semantics and Prometheus-format metrics from the operator CLI
- An append-only history of every payment's state changes and the evidence behind them,
  operator commands to find and investigate unresolved payments, an append-only audit trail of
  operator actions, and approximate API-key usage tracking
- Per-IP and per-merchant rate limiting with address-based proxy trust, Helmet security headers,
  an explicit CORS allowlist, and structured JSON logs with request correlation and credential
  redaction

> **PayGuard is a simulated payment system, not a live payment gateway.** No real provider is
> connected, no card data is accepted or stored, and no money moves. A `SUCCEEDED` payment means
> the simulator was configured to succeed. See [Known limitations](#known-limitations) before
> deploying it anywhere public.

## Prerequisites

| Tool                              | Version                                   |
| --------------------------------- | ----------------------------------------- |
| Node.js                           | 24 LTS (see `.nvmrc`)                     |
| npm                               | 11 (bundled with Node 24)                 |
| Docker with the Compose v2 plugin | Any recent release (Docker Desktop works) |

## Getting started

```bash
# 1. Configure the environment, then edit .env and replace every "change-me"
#    (the password must be the same in POSTGRES_PASSWORD and both URLs).
cp .env.example .env

# 2. Install dependencies from the lockfile (this also generates the Prisma client).
npm ci

# 3. Start PostgreSQL. On first start it also creates the payguard_test database.
docker compose up -d postgres

# 4. Apply database migrations.
npm run db:migrate:deploy

# 5. Provision a merchant; the API key is printed once.
npm run admin -- merchant:create --name "Acme Ltd"

# 6. Run the API in watch mode. It also runs the payment worker unless OUTBOX_WORKER_ENABLED=false,
#    in which case run `npm run build && npm run start:worker` in a second terminal.
npm run start:dev
```

Then call the API with the key from step 5:

```bash
curl -H "Authorization: Bearer pgsk_0123456789abcdef_REPLACE_WITH_YOUR_SECRET" \
  http://localhost:3000/v1/merchants/me

curl -X POST http://localhost:3000/v1/payments \
  -H "Authorization: Bearer pgsk_0123456789abcdef_REPLACE_WITH_YOUR_SECRET" \
  -H "Idempotency-Key: 6f1c1a0e-2b9e-4c1e-9d55-0b2f3c7a9e10" \
  -H "Content-Type: application/json" \
  -d '{"amount": 500000, "currency": "NGN", "reference": "order_10042"}'
```

- `GET /health` and `GET /health/live`: readiness and liveness (no authentication)
- `/docs`: Swagger UI when `SWAGGER_ENABLED=true`; use **Authorize** to send a key

### Run the whole stack in Docker

```bash
docker compose up --build
docker compose exec api node dist/cli/admin.js merchant:create --name "Acme Ltd"
```

This starts PostgreSQL and runs a one-off `migrate` job (`prisma migrate deploy`). It then starts
two services from the same production image: `api` (HTTP only, `OUTBOX_WORKER_ENABLED=false`) on
`127.0.0.1:${API_HOST_PORT}`, and `worker` (`node dist/worker.js`, no HTTP port). Both run as the
unprivileged `node` user with a read-only root filesystem (only `/tmp` is writable), all Linux
capabilities dropped, `no-new-privileges`, and a 30 s stop grace period. In a container, run the
admin CLI with `node dist/cli/admin.js` (there is no npm or TypeScript in the runtime image). Stop
the stack with `docker compose down`; add `-v` to delete the database volume as well.

## Commands

| Command                     | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `npm run start:dev`         | Start the API with file watching                                        |
| `npm run build`             | Compile to `dist/`                                                      |
| `npm run start:prod`        | Run the compiled app (`node dist/main.js`)                              |
| `npm run start:worker`      | Run the compiled standalone worker (`node dist/worker.js`)              |
| `npm run admin -- <cmd>`    | Build, then run the operator CLI (see [Operations](#operations))        |
| `npm test`                  | Unit tests (no database needed)                                         |
| `npm run test:cov`          | Unit tests with a coverage report in `coverage/`                        |
| `npm run test:e2e`          | Integration and HTTP tests against PostgreSQL (`TEST_DATABASE_URL`)     |
| `npm run test:soak`         | Opt-in concurrency soak with worker processes (see [Testing](#testing)) |
| `npm run smoke:docker`      | Build and smoke-test the Compose stack in an isolated project           |
| `npm run lint`              | ESLint with type-aware rules (`lint:fix` to auto-fix)                   |
| `npm run format:check`      | Check Prettier formatting (`format` to rewrite files)                   |
| `npm run typecheck`         | Type-check sources and tests without emitting output                    |
| `npm run prisma:generate`   | Regenerate the Prisma client after editing the schema                   |
| `npm run prisma:validate`   | Validate `prisma/schema.prisma`                                         |
| `npm run db:migrate:dev`    | Create and apply a migration in development                             |
| `npm run db:migrate:deploy` | Apply pending migrations (CI, Docker, production)                       |
| `npm run db:migrate:check`  | Fail if the migrated database and `schema.prisma` differ (CI)           |

## Configuration

All configuration comes from environment variables. In local development they are read from
`.env`; variables already set in the environment take precedence. The app validates them at
startup and exits with an error that names each invalid variable without printing its value.

The **Used by** column says which processes read a variable: `all` means the API, the standalone
worker and the operator CLI; `api` means the HTTP process only. The worker and the CLI do not
validate API-only settings, so a worker container does not need them.

| Variable                                  | Used by  | Default         | Description                                                                            |
| ----------------------------------------- | -------- | --------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                            | all      | required        | PostgreSQL connection string (`postgresql://...`)                                      |
| `NODE_ENV`                                | all      | `development`   | `development` (readable logs), `test` or `production` (JSON logs)                      |
| `PAYMENT_SIMULATOR_OUTCOME`               | all      | `SUCCEEDED`     | Simulator result for every payment: `SUCCEEDED`, `DECLINED`, `UNAVAILABLE`             |
| `PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS` | all      | `false`         | `true`: submissions are processed but time out; outcomes come from lookup              |
| `OUTBOX_POLL_INTERVAL_MS`                 | all      | `1000`          | Idle delay between outbox polls (100-60000)                                            |
| `OUTBOX_LEASE_SECONDS`                    | all      | `60`            | How long a claimed job is owned before another worker may take it (≥ 30)               |
| `OUTBOX_MAX_RUNS`                         | all      | `10`            | Runs per job before it is parked as `DEAD` for investigation                           |
| `OUTBOX_BACKOFF_MAX_SECONDS`              | all      | `300`           | Cap for the exponential retry delay (2 s, 4 s, 8 s, ...)                               |
| `RECONCILIATION_DELAY_SECONDS`            | all      | `60`            | Wait before the first lookup of an unknown outcome; also the stale-attempt age         |
| `PAYGUARD_OPERATOR`                       | CLI      | `<user>@<host>` | Actor recorded in the audit trail for CLI actions (printable ASCII, ≤ 200)             |
| `SIMULATOR_WEBHOOK_SECRET`                | api, CLI | unset           | Webhook signing secret, 32-256 visible ASCII, not an API key; unset disables webhooks  |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`     | api      | `300`           | Allowed difference between a webhook's signed timestamp and the clock (30-900)         |
| `PORT`                                    | api      | `3000`          | HTTP port                                                                              |
| `SWAGGER_ENABLED`                         | api      | `false`         | `true` serves Swagger UI at `/docs`                                                    |
| `CORS_ALLOWED_ORIGINS`                    | api      | empty           | Comma-separated exact origins; empty sends no CORS headers                             |
| `OUTBOX_WORKER_ENABLED`                   | api      | `true`          | Also run the worker inside the API process; `false` when a standalone worker runs      |
| `RATE_LIMIT_IP_PER_MINUTE`                | api      | `300`           | Requests per client IP per minute, all routes except health checks                     |
| `RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE`   | api      | `60`            | Payment creations and retries per merchant per minute                                  |
| `TRUSTED_PROXIES`                         | api      | empty           | Proxy addresses allowed to set `X-Forwarded-For` (see [Rate limiting](#rate-limiting)) |
| `HEALTH_QUEUE_BACKLOG_SECONDS`            | api      | `120`           | `/health` queue check: age at which due jobs or expired leases count as stuck (≥ 10)   |
| `HEALTH_WORKER_TIMEOUT_SECONDS`           | api      | `30`            | `/health` worker check: heartbeat age after which a worker counts as gone (≥ 20)       |
| `TEST_DATABASE_URL`                       | tests    | required        | Database for `npm run test:e2e`; its name must end with `_test`                        |
| `POSTGRES_USER` / `_PASSWORD` / `_DB`     | Compose  | required        | Credentials for the Compose PostgreSQL container                                       |
| `POSTGRES_HOST_PORT` / `API_HOST_PORT`    | Compose  | `5432`/`3000`   | Host ports published by Compose (bound to 127.0.0.1)                                   |

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
5. Missing, malformed, unknown, wrong-secret, revoked, expired and suspended-merchant
   credentials all return the same `401 Invalid API key` (or `Missing API key` when there is no
   header), with a `WWW-Authenticate: Bearer` challenge. The specific reason and the non-secret
   prefix go to the server log only.
6. The plaintext key exists only in memory during issuance and in the CLI output. It is never
   stored, logged or returned again.
7. **Usage is recorded approximately.** A successful authentication sets `last_used_at`, but each
   API process writes it at most once per key every 15 minutes, and only when the stored value is
   older than that. So the value is accurate to about 15 minutes, costs at most one small `UPDATE`
   per key per window, and is never written on rejected requests. A failed write is logged and
   does not fail the request. It is shown by `key:list` and `GET /v1/api-keys`.

### Authentication in the application

- `ApiKeyGuard` is registered globally (`APP_GUARD`), so every route requires a key unless it is
  marked `@Public()`. Today only the health controller is public; Swagger UI is served outside the
  Nest router.
- Keys are accepted only in the `Authorization: Bearer` header, never in query strings or bodies.
- Controllers get the caller from `@CurrentMerchant()`, which returns `{ merchantId, apiKeyId }`
  set by the guard. **Never take a merchant ID from the path, query, headers or body.** Services
  scope every query by that `merchantId`, so another merchant's resource behaves exactly like one
  that does not exist (404). `GET /v1/api-keys/:id` is the reference implementation.

Merchant endpoints:

| Method and path        | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `GET /v1/merchants/me` | The merchant that owns the presented key                     |
| `GET /v1/api-keys`     | The caller's keys (prefix, label, status, dates; no secrets) |
| `GET /v1/api-keys/:id` | One of the caller's keys; 404 for anyone else's              |

There are deliberately no HTTP endpoints for registering merchants or managing keys.

## Payments

> Every payment is processed by the built-in simulator, whose result comes from operator
> configuration, never from the request. No real money moves.

### API

| Method and path               | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `POST /v1/payments`           | Create a payment and queue its first attempt. Requires `Idempotency-Key`.         |
| `POST /v1/payments/:id/retry` | Queue a new attempt for an eligible `FAILED` payment. Requires `Idempotency-Key`. |
| `GET /v1/payments/:id`        | A payment owned by the caller, with its attempts. 404 for anyone else's or none.  |

Processing is asynchronous: both `POST` operations return `202 Accepted` with the payment
`PENDING`, and the outcome appears on `GET /v1/payments/:id` once the worker has processed it
(normally within about a second).

Request body. Only these fields are accepted; anything else, such as `merchantId`, `status` or
provider data, is rejected with 400:

| Field       | Type    | Rules                                                                                              |
| ----------- | ------- | -------------------------------------------------------------------------------------------------- |
| `amount`    | integer | Minor units, `1` to `1000000000000`. JSON numbers only, never strings or decimals.                 |
| `currency`  | string  | One of the supported ISO 4217 codes below, uppercase.                                              |
| `reference` | string  | Optional, 1-64 of `A-Z a-z 0-9 . _ : / # -`. Your own label; not unique, not used for idempotency. |

A processed payment, as returned by `GET` (a new payment looks the same with `status: "PENDING"`
and one `PENDING` attempt without a reference):

```json
{
  "id": "01a16b6d-bf6d-765f-98fb-39c95d75fe23",
  "amount": 500000,
  "currency": "NGN",
  "status": "SUCCEEDED",
  "reference": "order_10042",
  "failureCode": null,
  "attempts": [
    {
      "id": "01a16b6d-bf72-73ea-83b1-f39d1c06083f",
      "attemptNumber": 1,
      "provider": "simulator",
      "status": "SUCCEEDED",
      "providerReference": "sim_7b4affd0040515a3582e3ba9",
      "failureCode": null,
      "createdAt": "2026-10-24T01:01:56.974Z",
      "completedAt": "2026-10-24T01:01:57.998Z"
    }
  ],
  "createdAt": "2026-10-24T01:01:56.974Z",
  "updatedAt": "2026-10-24T01:01:58.019Z"
}
```

| Status | When                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- |
| `202`  | Payment created, or retry accepted; the new attempt is queued and the payment is `PENDING`.             |
| `200`  | Replay of an earlier request with the same key; header `Idempotent-Replayed: true`. Current state.      |
| `400`  | Invalid body or `Idempotency-Key` (field-level `details`), malformed JSON, bad payment id.              |
| `401`  | Missing or invalid API key.                                                                             |
| `404`  | Payment does not exist or belongs to another merchant (indistinguishable by design).                    |
| `409`  | `Idempotency-Key` already used with a different request, or the payment is not eligible for a retry.    |
| `429`  | Rate limit exceeded; `Retry-After` gives the seconds to wait.                                           |
| `500`  | Unexpected server error; generic message, details only in the server log. Nothing is left half-created. |

All errors use the standard error body (with `requestId`). Internal fields such as the
idempotency key, request fingerprint and raw provider data are never returned.

### Lifecycle

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
  reconciliation because the provider's answer was lost (see below).
- Failure codes are `DECLINED` (the provider refused the payment) and `PROVIDER_UNAVAILABLE` (the
  provider refused to process anything, so the payment was not attempted). An outage is never
  recorded as a decline.
- The transition tables in `src/payments/payment-lifecycle.ts` are the only definition of allowed
  changes. Every status write is a conditional `UPDATE ... WHERE status IN (allowed sources)`
  derived from them, inside one transaction for the attempt and its payment, so a late or
  duplicate provider result cannot overwrite a terminal state.
- **Retry eligibility** (`retryEligibility()`): a `FAILED` payment with no attempt in flight,
  whose latest failure is retryable (both codes are; a decline may be resolved by the customer),
  and with fewer than 3 attempts. Otherwise the retry is refused with `409` and the reason
  (`payment_not_failed`, `attempt_in_progress`, `failure_not_retryable`, `attempt_limit_reached`).
  A payment whose outcome is unknown is still `PENDING`, so it can never be retried into a second
  charge, and a `SUCCEEDED` payment has no outgoing transition at all.
- A retry never rewrites history: earlier attempts keep their `FAILED` status and failure code,
  and the payment's `failureCode` is cleared only while the new attempt is in progress.
- The database enforces the invariants as well. Amounts must be positive, and `completed_at` must
  be set exactly when an attempt is no longer `PENDING`. A failure code must be present exactly
  when an attempt is `FAILED`, and a payment can have at most one `PENDING` attempt (a partial
  unique index).

### Idempotency

Both `POST` operations need an `Idempotency-Key` header: 1-255 visible ASCII characters, unique per
operation you intend to perform (a UUID is ideal). Creation keys and retry keys are separate
namespaces, so reusing a value across the two never makes either request ambiguous.

| Operation | Stored in                                            | Unique per | Same request means                     |
| --------- | ---------------------------------------------------- | ---------- | -------------------------------------- |
| Create    | `payments.idempotency_key`                           | merchant   | same `amount`, `currency`, `reference` |
| Retry     | `payment_retry_requests` (one row per retry attempt) | merchant   | same payment ID                        |

- **Same key, same request:** `200` with `Idempotent-Replayed: true` and the payment's **current**
  state, which may have moved on since the first response (e.g. `PENDING` → `SUCCEEDED`). No
  payment, attempt or job is created and nothing more is queued for the provider.
- **Same key, different request:** `409 Conflict`. Requests are compared by a SHA-256 fingerprint
  of a versioned canonical form built from the validated input:
  `["payments.create.v1", amount, currency, reference ?? null]` or
  `["payments.retry.v1", paymentId]`. JSON key order and whitespace do not matter.
- **Concurrency:** unique constraints on `(merchant_id, idempotency_key)` decide races. Concurrent
  creations with one key race on the insert; the losers hit the constraint and are answered from
  the winner's row. Retries additionally lock the payment row (`SELECT ... FOR UPDATE`), so
  concurrent retries of one payment run one at a time: with the same key the later ones replay,
  with different keys they find the payment no longer `FAILED` and get `409`.
- **Retention:** keys never expire.

### Currencies and amounts

Amounts are integers in the currency's **minor unit**, stored as `BIGINT`, never floating point.
The number of decimals differs by currency, so never convert by assuming two decimals:

| Currency                          | Minor-unit digits | `amount: 1500` means |
| --------------------------------- | ----------------- | -------------------- |
| NGN, GHS, KES, ZAR, USD, EUR, GBP | 2                 | 15.00                |
| JPY                               | 0                 | 1500                 |
| KWD                               | 3                 | 1.500                |

The list lives in `src/payments/currencies.ts`. The maximum amount (10^12 minor units) keeps values
exact in JSON numbers.

### Processing and recovery

The database is the source of truth for work still to do. Every attempt is processed through a
transactional **outbox** (`outbox_jobs`), drained by one or more workers (see
[Worker deployment](#worker-deployment)).

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
  that makes it; see [Investigating a payment](#investigating-a-payment).
- **Shutdown:** on SIGTERM a worker stops polling, waits for the batch in flight, marks itself
  stopped, and only then is the database pool closed. A process killed outright leaves its claimed
  jobs to be recovered when their leases expire.

**What is and is not guaranteed.** The system does not claim exactly-once external processing.
Each mechanism covers a specific failure:

- Database uniqueness prevents duplicate payments, attempts, retries and jobs.
- The outbox guarantees that every accepted attempt is processed at least once, even across
  crashes.
- The `submitted_at` marker and lookups prevent a lost answer from turning into a second
  submission.
- The stable attempt ID lets a provider deduplicate any resubmission that still happens.

Together these give at-most-one charge per attempt only if the provider honours its idempotency
key and answers lookups consistently once a submission's timeout has passed. The simulator
behaves that way; a real provider must be verified to.

### Worker deployment

The same worker code runs in one of two places:

| Mode                 | How                                                                                                                  | Use when                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| In-process (default) | `OUTBOX_WORKER_ENABLED=true`: each API process also polls the outbox                                                 | Local development, single-instance deployments |
| Standalone           | `node dist/worker.js` (`npm run start:worker`) on dedicated processes, with `OUTBOX_WORKER_ENABLED=false` on the API | Production: Docker Compose runs it this way    |

- **Why standalone in production:** a backlog or slow provider then cannot take CPU, event-loop
  time or database connections from HTTP traffic. Workers and API instances scale and restart
  independently, and a crashing worker does not take the API down. The worker process has no HTTP
  server, loads no HTTP, auth or rate-limit code, and validates only the shared settings.
- **Why the in-process default stays:** it is one process to run, and correctness does not depend
  on the choice. Claiming, leases and fencing work the same with any number of workers in any mix
  of processes, so both modes can even run at once during a migration.
- **Heartbeats:** every worker writes a row in `outbox_workers` (`<host>:<pid>:<random>`) when it
  starts, about every 10 s, and when it stops. `/health` and `ops:status` read these rows, so they
  report workers on every instance, not only the one answering.
- **Graceful stop:** give a worker more time than its slowest batch. Provider calls time out after
  10 s; Compose uses `stop_grace_period: 30s`. Anything still unfinished when the process is killed
  is recovered through lease expiry.

### Simulator

`SimulatedPaymentProvider` makes no network calls. It returns the outcome configured in
`PAYMENT_SIMULATOR_OUTCOME` for every payment, and its lookups report the same outcome:

| Setting       | Payment result                                | Attempt                               | Lookup    |
| ------------- | --------------------------------------------- | ------------------------------------- | --------- |
| `SUCCEEDED`   | `SUCCEEDED`                                   | `SUCCEEDED`, reference `sim_<24 hex>` | succeeded |
| `DECLINED`    | `FAILED`, `failureCode: DECLINED`             | `FAILED`, reference `sim_<24 hex>`    | declined  |
| `UNAVAILABLE` | `FAILED`, `failureCode: PROVIDER_UNAVAILABLE` | `FAILED`, no reference                | not found |

With `PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS=true`, every submission is treated as processed but
its answer times out. Payments then stay `PENDING` until reconciliation looks them up, after
`RECONCILIATION_DELAY_SECONDS` (set it low, e.g. `5`, for demos), and records the outcome. The
simulated ledger is a pure function of the configuration and the attempt ID, so lookups give the
same answer after a restart. It assumes every attempt it is asked about was submitted, so it
cannot reproduce "never received" except in `UNAVAILABLE` mode.

To reproduce an outcome, set the variables and restart, e.g.
`PAYMENT_SIMULATOR_OUTCOME=DECLINED npm run start:dev`, or in Compose
`PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS=true docker compose up -d worker` (provider calls happen
in the worker service there). Merchants cannot influence the outcome. Every process that loads
the provider, the API and the worker, logs a warning at startup that payments are simulated.

### Provider webhooks

A provider notifies PayGuard of outcomes by webhook. PayGuard treats each one as a signed claim
about an attempt, not as permission to set a payment's state: it authenticates the bytes, stores
the event, acknowledges it, and applies it later through the outbox, under the same lifecycle
guards as every other outcome. Only the simulator's endpoint exists.

**Request.** `POST /v1/webhooks/simulator`, `Content-Type: application/json`, at most 64 KiB, not
compressed, no API key:

```
X-Simulator-Signature: t=1792843200,v1=5f2c...e81a   (64 lowercase hex characters)
```

```json
{
  "id": "evt_9f2e4c1b7a6d3e5f8a0b2c4d",
  "type": "payment.succeeded",
  "createdAt": "2026-10-25T12:00:00.000Z",
  "data": {
    "attemptId": "01a16b6d-bf72-73ea-83b1-f39d1c06083f",
    "providerReference": "sim_7b4affd0040515a3582e3ba9",
    "amount": 500000,
    "currency": "NGN"
  }
}
```

| Field                     | Meaning                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                      | The provider's stable event ID (`evt_` + 8-64 letters or digits); the same on every redelivery |
| `type`                    | `payment.succeeded`, `payment.declined` or `payment.processing` (informational only)           |
| `createdAt`               | When the provider created the event (ISO 8601, UTC)                                            |
| `data.attemptId`          | The idempotency reference PayGuard sent with the submission, i.e. the attempt ID               |
| `data.providerReference`  | The provider's own reference for the attempt                                                   |
| `data.amount`, `currency` | What the provider charged; compared with the payment, never used to change it                  |

The event carries no payment ID, merchant ID or status, and any undeclared field is rejected: the
attempt, its payment and its merchant come from PayGuard's records.

**Signature.** `v1` is the hex HMAC-SHA256, keyed with `SIMULATOR_WEBHOOK_SECRET`, of the signed
timestamp `t`, a `.`, and the raw body bytes exactly as sent. The body is read as raw bytes before
any JSON parsing, so verification never depends on how JSON is re-serialized, and only verified
bytes are parsed. The header format is checked strictly and the digests are compared in constant
time. A `t` more than `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` away from the server clock, in either
direction, is rejected, which bounds how long a captured delivery can be replayed; within that
window, replays are caught by event-ID deduplication. The secret is used for nothing else and
must not be a merchant API key. Secrets, signatures and bodies are never logged.

**Responses.** Bodies contain no payment data.

| Status | When                                                                                                  | Provider should |
| ------ | ----------------------------------------------------------------------------------------------------- | --------------- |
| `202`  | `{"status":"accepted"}`: stored, and its processing queued in the same transaction                    | stop            |
| `200`  | `{"status":"duplicate"}`: this event ID was already stored with the same content                      | stop            |
| `400`  | Signed, but not UTF-8 JSON, not an object, or not a valid event (unsupported type, extra fields, ...) | fix, not retry  |
| `401`  | Signature header missing, malformed, wrong, or its timestamp outside the tolerance                    | fix, not retry  |
| `409`  | This event ID was already stored with different content                                               | investigate     |
| `413`  | Body over 64 KiB                                                                                      | fix, not retry  |
| `415`  | Not `application/json`, or a compressed body                                                          | fix, not retry  |
| `429`  | The per-IP rate limit, which applies to this route like any other                                     | retry later     |
| `503`  | `SIMULATOR_WEBHOOK_SECRET` is not set, or the event could not be stored                               | retry later     |

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

**Sending simulator webhooks.** The simulator's events are deterministic: the event ID derives
from the attempt ID and event type, and the reference matches its submissions. The operator CLI
can sign and deliver one over HTTP, as the provider would. It is refused when
`NODE_ENV=production`:

```bash
npm run admin -- simulator:webhook --attempt <attempt-id> [--type payment.declined] [--url http://127.0.0.1:3000]
```

The type defaults to the configured `PAYMENT_SIMULATOR_OUTCOME`, and the event's `createdAt` to
the attempt's creation time, so running the command again, before or after the worker submits
the attempt, redelivers the same event (a duplicate). With `PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS=true`, a webhook resolves a `PENDING`
payment before its delayed lookup runs, which then finds nothing left to do.

### Rate limiting

| Limit                                   | Key       | Default | Applies to                                                      |
| --------------------------------------- | --------- | ------- | --------------------------------------------------------------- |
| `RATE_LIMIT_IP_PER_MINUTE`              | client IP | 300/min | every route except `/health*`, **before** API-key checks        |
| `RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE` | merchant  | 60/min  | `POST /v1/payments` and `/retry` combined, after authentication |

- Token buckets allow a burst up to the limit, then refill steadily. Over the limit, the response
  is `429` with `Retry-After: <seconds>` and the standard error body.
- The per-IP limit runs before authentication, so floods of invalid keys are rejected without a
  database lookup.
- A `429` is returned before any idempotency processing, so nothing is created. Retrying later
  with the same `Idempotency-Key` is safe. Replays count toward the limit.
- **IPv6 clients are grouped by /64.** A single host usually controls a whole /64, so limiting
  individual IPv6 addresses would let it rotate around the limit. IPv4 addresses (including
  IPv4-mapped IPv6) are limited individually.
- **Process-local:** counters live in each API process's memory, so `N` instances allow `N` times
  the configured limit, and a restart resets them. These limits protect one process from abuse;
  they are not a global quota. For a cluster-wide limit, enforce it at the load balancer or API
  gateway, or move the buckets to a shared store (for example a PostgreSQL table or Redis, which
  this project deliberately does not use).

**Client IP behind a proxy.** By default the TCP peer address is the client and
`X-Forwarded-For` is ignored, so it cannot be spoofed. Behind a reverse proxy or load balancer,
list the proxy addresses in `TRUSTED_PROXIES` (comma-separated IPs, CIDR ranges, or `loopback`,
`linklocal`, `uniquelocal`):

```bash
TRUSTED_PROXIES=10.0.0.0/8          # proxies on the private network
TRUSTED_PROXIES=loopback            # a proxy on the same host
```

The client IP is then the right-most `X-Forwarded-For` entry that is not a trusted proxy, so a
value a client prepends itself is skipped. Trust is decided by the address of the peer, never by
a hop count: a client that connects directly is never trusted, whatever header it sends. List
only real proxies; `0.0.0.0/0`, `::/0` and any other `/0` range are rejected at startup.

## Operations

Merchant and key administration is done with the operator CLI, which talks to the database
directly and is therefore not reachable over HTTP. Locally use `npm run admin -- <command>`; in a
container use `node dist/cli/admin.js <command>`.

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

### Payment processing

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
- **A dead `PROCESS_ATTEMPT` job** failed internally repeatedly, or crashed its workers (see poison
  jobs in [Processing and recovery](#processing-and-recovery)). Check the logs for its `jobId`
  before requeueing. The stale sweep queues a lookup for its attempt, which resubmits only if the
  provider never received it.
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

### Investigating a payment

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

### Health checks

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

### Metrics

```bash
npm run admin -- ops:metrics   # Prometheus text exposition format, on stdout
```

`ops:metrics` prints a snapshot computed from the database, so any one invocation describes the
whole system. There is no `/metrics` HTTP endpoint; to scrape it, run the command on a schedule
(for example a cron job writing to the node_exporter textfile collector). Every metric is a gauge,
and label values come only from fixed enums (`type`, `status`, `category`, `failure_code`,
`quantile`, `result`), never from IDs, event IDs, merchants or free text (nothing a webhook sender
controls becomes a label), so the series count is bounded. Values
describe the rows currently retained, so outbox counts and sums can drop after
`maintenance:prune`; alert on levels and short-window increases rather than on lifetime totals.

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

### Alerting recommendations

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

### Audit trail

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
- **Append-only, not tamper-proof:** a database trigger rejects every `UPDATE` and `DELETE` on the
  table, so application code cannot rewrite history. A database owner can still drop the trigger.
  For tamper evidence, ship events to an external, write-once store.
- Events are kept indefinitely; `maintenance:prune` never touches them.
- Provider evidence and the worker's own decisions are not operator actions and are not written
  here; they are in each payment's history (see [Investigating a payment](#investigating-a-payment)),
  whose table has the same append-only trigger and the same limits.

### Data retention

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

## Architecture

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
├── config/                 # Core and API environment schemas, validation, config modules
├── common/http/            # Error format, exception filter, request IDs, validation
├── common/logging/         # Structured logger, request context, access log
├── common/rate-limit/      # Token-bucket limiter and the per-IP / per-merchant guards
├── database/               # PrismaService (pg driver adapter) and DatabaseModule
├── health/                 # /health (database, queue, workers) and /health/live
└── generated/prisma/       # Generated Prisma client (gitignored; created by npm install)
prisma/
├── schema.prisma
└── migrations/
test/                       # Integration and HTTP tests against real PostgreSQL, and the soak test
scripts/docker-smoke.sh     # Compose stack smoke test (npm run smoke:docker, CI)
```

Payment providers plug in as `PaymentProvider` implementations bound to the `PAYMENT_PROVIDER`
token; the payment domain depends only on that interface.

### Conventions

- **Layers.** Controllers handle HTTP only: routing, DTO validation and status codes. Services
  hold the logic and throw domain errors (e.g. `MerchantNotFoundError`) that controllers and the
  CLI translate. Persistence goes through `PrismaService`.
- **Configuration.** Read config through `ConfigService<CoreEnvironment, true>` (code shared with
  the worker and CLI) or `ConfigService<ApiEnvironment, true>` (HTTP-only code), never through
  `process.env`. To add a variable, declare it on the narrowest class in
  `src/config/environment.ts` and in `.env.example`.
- **Versioning.** Business endpoints are served under `/v1/...`. Operational endpoints opt out
  with `VERSION_NEUTRAL`.
- **Validation.** A global `ValidationPipe` uses `whitelist` and `forbidNonWhitelisted`, so
  properties not declared on the DTO are rejected rather than silently dropped.
- **Errors.** Every error response has the same shape:

  ```json
  {
    "statusCode": 400,
    "error": "Bad Request",
    "message": "Validation failed",
    "details": [
      {
        "field": "items.0.amount",
        "messages": ["amount must be a positive number"]
      }
    ],
    "path": "/v1/payments",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "requestId": "6f1c1a0e-2b9e-4c1e-9d55-0b2f3c7a9e10"
  }
  ```

  Unexpected errors become a generic 500 with the stack trace logged server-side. Bodies the
  parser rejects keep their client status (`413` for over 100 KiB of JSON, `415` for unsupported
  encodings) with a generic message. `path` never includes the query string.

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
- **Health.** See [Health checks](#health-checks).

### Platform notes

- **NestJS 12 uses native ES modules** (`"type": "module"`). Relative imports need the `.js`
  suffix (`import { X } from './x.js'`), even in TypeScript files.
- **Jest runs in ESM mode** (`--experimental-vm-modules`, ts-jest ESM preset). Test files import
  `describe`, `it`, `expect` and `jest` from `@jest/globals`.
- **Prisma 7** keeps its CLI configuration in `prisma.config.ts`, generates the client into
  `src/generated/prisma` (not committed), and connects through the `@prisma/adapter-pg` driver
  adapter. `migrate dev` no longer regenerates the client; run `npm run prisma:generate` after
  schema changes.

## Testing

- **Unit tests** (`src/**/*.spec.ts`), with no database:
  - API keys: generation, parsing, comparison, and the guard's behaviour on every rejection path.
  - Logging and configuration: log redaction, and validation of the core and API settings,
    including which proxy entries are accepted.
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
- **Integration and HTTP tests** (`test/**/*.e2e-spec.ts`) run against **real PostgreSQL**:
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
- Tests swap the provider through `createTestApp({ provider })`. The `ScriptedProvider` test
  double keeps a ledger of what it "processed", can lose answers, fail or hold a call open, and
  counts submissions and lookups. Tests drive the worker directly (`processDueJobs()`), and move
  time by editing timestamps in the test database with its own clock, so none of them sleep
  (tests of running worker loops wait for a condition, within a deadline). Failures are injected
  with temporary triggers in that database.
- When a worker batch handles a different number of jobs than a test expects, the failure lists
  both clocks and every job's status, due time, lease and last error (`processDueJobsExpecting`
  in `test/support/outbox.ts`).

### Concurrency soak test

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

### Docker smoke test

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
- neither the webhook secret nor the API key appears in the logs.

It removes its containers, network and volume on exit, after a failure or a cancellation too,
printing the services' recent logs when it fails.

### Test database

- Tests use only `TEST_DATABASE_URL`, and refuse to start unless its database name ends with
  `_test`. There is no fallback to `DATABASE_URL`.
- Jest's global setup applies migrations to that database (`prisma migrate deploy`) before any
  test runs.
- Every test starts from empty tables: a single `TRUNCATE` over all application tables (which
  satisfies foreign keys) runs in `beforeEach`, after confirming the connected database is a
  `_test` one.
- Integration test files run one at a time (`maxWorkers: 1` in `jest.e2e.config.js`), because they
  share the database. Unit tests still run in parallel.
- Locally, Compose creates `payguard_test` on the first start of the data volume.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

1. **verify**: `npm ci` → `format:check` → `lint` → `typecheck` → `prisma:validate` → unit tests
   → `db:migrate:deploy` → `db:migrate:check` → integration tests (PostgreSQL 18 service
   container) → `build`.
2. **docker**: `npm run smoke:docker`, which builds the images and smoke-tests the whole Compose
   stack (see [Docker smoke test](#docker-smoke-test)).

The soak test is not part of CI: run it on demand.

Each CI step calls the same npm scripts you run locally.

## Known limitations

- **Simulated payments only.** There is no real provider integration, card handling, capture,
  refund or payout. A real `PaymentProvider` would need at least:
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
- **No exactly-once guarantee; at most one charge per attempt depends on the provider.** The guarantees in
  [Processing and recovery](#processing-and-recovery) assume the provider deduplicates by attempt
  ID and answers lookups consistently. The simulator does by construction; a real provider must be
  verified.
- **Automatic reconciliation is bounded.** After `OUTBOX_MAX_RUNS` inconclusive lookups the
  payment stays `PENDING` and needs an operator. The window is about 13 minutes with the defaults.
- **The in-process worker shares the API process** (the default outside Compose). A heavy backlog
  then competes with HTTP traffic; run the standalone worker in production (see
  [Worker deployment](#worker-deployment)).
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
  the audit trail, it is append-only for the application but not protected from a database owner.
  Refused retries change nothing and are not recorded (the merchant gets the `409` and reason).
- **Retention is manual.** Payments, attempts, idempotency keys, audit and webhook events grow without
  bound by design; only completed outbox jobs and worker rows can be pruned, and only when an
  operator runs `maintenance:prune`. There is no archiving.
- **Rate limits are per process**, reset on restart, and depend on `TRUSTED_PROXIES` listing
  exactly the real proxies (see [Rate limiting](#rate-limiting)).
- **Idempotency keys never expire**, and a replay returns the current payment state rather than a
  stored copy of the first response.
- **Key usage is approximate** (to about 15 minutes per API process), and nothing flags keys that
  have been unused for a long time.
- **The audit actor is self-declared and the trail is not tamper-proof.** The CLI authenticates
  nobody: whoever can reach the database is an administrator, and a database owner can disable
  the append-only trigger.
- **No built-in metrics endpoint or alerting.** Metrics are a CLI snapshot for an external
  scraper; the thresholds in [Alerting recommendations](#alerting-recommendations) are untested
  suggestions.
- **The standalone worker has no health endpoint.** Its liveness is the process itself plus the
  heartbeat-based `workers` check; a worker that is alive but wedged inside one batch shows up as
  a stale heartbeat, not a failed probe.
- **Expiry is enforced, but nothing alerts before a key expires.**
- **HTTPS is assumed to terminate in front of the API.** HSTS is sent, but the app itself serves
  plain HTTP.
- **Swagger UI under Helmet's CSP** was checked statically (no inline scripts, all assets
  same-origin), not in a browser.

## Troubleshooting

| Symptom                                                      | Fix                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Missing API key`                                        | Send `Authorization: Bearer <key>`. Keys in query strings are ignored by design.                                                                                                                                                                                                                                                                                    |
| `401 Invalid API key` with a key you just created            | Check for truncation or extra whitespace, then `key:list` for its status and `merchant:list` for suspension. The server log names the rejection reason.                                                                                                                                                                                                             |
| `400` with `field: "Idempotency-Key"`                        | Send an `Idempotency-Key` header of 1-255 visible ASCII characters (no spaces).                                                                                                                                                                                                                                                                                     |
| `409 Idempotency-Key has already been used...`               | The key belongs to an earlier operation with a different request. Use a new key for a new operation, or resend the original request to read the result.                                                                                                                                                                                                             |
| `429 Rate limit exceeded`                                    | Wait `Retry-After` seconds. If every client is limited together behind a proxy, list the proxy's address in `TRUSTED_PROXIES`.                                                                                                                                                                                                                                      |
| A payment stays `PENDING`                                    | Run `payment:inspect --payment <id>` for its state and history, or `payments:unresolved` for all of them. No active worker in `ops:status` means nothing is processing (start `worker`, or set `OUTBOX_WORKER_ENABLED=true`); `reconciliation_exhausted` means the provider never gave a definite answer (see [Investigating a payment](#investigating-a-payment)). |
| `/health` shows `workers` with `no_active_worker`            | No worker has sent a heartbeat within `HEALTH_WORKER_TIMEOUT_SECONDS`. With the API's worker disabled, check that the `worker` service is running and can reach PostgreSQL (`docker compose logs worker`).                                                                                                                                                          |
| `/health` shows `queue` with `dead_jobs`                     | Run `ops:status` for the dead jobs, then follow [Payment processing](#payment-processing).                                                                                                                                                                                                                                                                          |
| `TRUSTED_PROXIES must be comma-separated IP addresses ...`   | Use IPs, CIDR ranges with a prefix of at least 1, or `loopback`/`linklocal`/`uniquelocal`. `0.0.0.0/0` is rejected on purpose.                                                                                                                                                                                                                                      |
| `TRUST_PROXY_HOPS` has no effect                             | It is not a PayGuard setting; use `TRUSTED_PROXIES`.                                                                                                                                                                                                                                                                                                                |
| `maintenance:prune` refuses a value                          | Retention must be at least 7 days and the batch size 1-10000.                                                                                                                                                                                                                                                                                                       |
| Webhooks answer `503 Webhooks are not configured`            | Set `SIMULATOR_WEBHOOK_SECRET` for the API (Compose passes it through from your shell or `.env`).                                                                                                                                                                                                                                                                   |
| Webhooks answer `401 Invalid webhook signature`              | The server log names the reason: `signature_missing`, `signature_malformed`, `signature_mismatch`, `signature_timestamp_too_old` or `signature_timestamp_in_future`. Sign the exact bytes you send with the same secret, and check both clocks.                                                                                                                     |
| Webhooks answer `409`                                        | The event ID was stored earlier with different content. A redelivery must carry the same event (formatting may differ); a new event needs a new ID.                                                                                                                                                                                                                 |
| `simulator:webhook` says it is disabled                      | It refuses to run with `NODE_ENV=production`. In a Compose container, run it with `docker compose exec -e NODE_ENV=development api node dist/cli/admin.js simulator:webhook ...` on a non-production stack.                                                                                                                                                         |
| `409 Payment cannot be retried: <reason>`                    | Only `FAILED` payments with fewer than 3 attempts can be retried; a `PENDING` payment is still being processed or reconciled.                                                                                                                                                                                                                                       |
| `Refusing to run integration tests against "..."`            | `TEST_DATABASE_URL` must point at a database whose name ends with `_test`.                                                                                                                                                                                                                                                                                          |
| `TEST_DATABASE_URL must be set to run integration tests`     | Add `TEST_DATABASE_URL` to `.env` (see `.env.example`).                                                                                                                                                                                                                                                                                                             |
| `database "payguard_test" does not exist`                    | The init script runs only on a fresh volume. Run `docker compose exec postgres createdb -U payguard payguard_test`, or reset with `docker compose down -v`.                                                                                                                                                                                                         |
| `Property 'merchant' does not exist on type 'PrismaService'` | The generated client is stale. Run `npm run prisma:generate`.                                                                                                                                                                                                                                                                                                       |
| `Bind for 127.0.0.1:5432 failed: port is already allocated`  | Another PostgreSQL is running. Set `POSTGRES_HOST_PORT` (e.g. `5434`) in `.env` and update the port in both database URLs.                                                                                                                                                                                                                                          |
| `EADDRINUSE` on start                                        | Change `PORT` (local) or `API_HOST_PORT` (Compose) in `.env`.                                                                                                                                                                                                                                                                                                       |
| `Invalid environment configuration: ...`                     | The listed variables are missing or malformed. Compare `.env` with `.env.example`.                                                                                                                                                                                                                                                                                  |
| `/health` returns 503 with `Database is unreachable`         | Check that PostgreSQL is running and that `DATABASE_URL` matches the Compose credentials. The server log has the real error.                                                                                                                                                                                                                                        |
| Database authentication fails although the password is right | URL-encode special characters in the password inside `DATABASE_URL` (e.g. `@` → `%40`).                                                                                                                                                                                                                                                                             |
| `ExperimentalWarning: VM Modules is an experimental feature` | Expected: Jest's ESM mode prints this. It is harmless.                                                                                                                                                                                                                                                                                                              |
| Prisma suggests updating to `8.0.0-rc.*`                     | Ignore it. Prisma publishes release candidates under its `latest` tag, and this project pins the stable 7.10.1.                                                                                                                                                                                                                                                     |
| Prettier reports every file as changed on Windows            | Line endings: `.gitattributes` enforces LF. Re-checkout, or set `git config core.autocrlf false`.                                                                                                                                                                                                                                                                   |
