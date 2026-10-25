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
- A worker that runs inside the API or as its own process, with heartbeats, explicit health
  semantics and Prometheus-format metrics from the operator CLI
- An append-only audit trail of operator actions, and approximate API-key usage tracking
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

| Command                     | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `npm run start:dev`         | Start the API with file watching                                    |
| `npm run build`             | Compile to `dist/`                                                  |
| `npm run start:prod`        | Run the compiled app (`node dist/main.js`)                          |
| `npm run start:worker`      | Run the compiled standalone worker (`node dist/worker.js`)          |
| `npm run admin -- <cmd>`    | Build, then run the operator CLI (see [Operations](#operations))    |
| `npm test`                  | Unit tests (no database needed)                                     |
| `npm run test:cov`          | Unit tests with a coverage report in `coverage/`                    |
| `npm run test:e2e`          | Integration and HTTP tests against PostgreSQL (`TEST_DATABASE_URL`) |
| `npm run lint`              | ESLint with type-aware rules (`lint:fix` to auto-fix)               |
| `npm run format:check`      | Check Prettier formatting (`format` to rewrite files)               |
| `npm run typecheck`         | Type-check sources and tests without emitting output                |
| `npm run prisma:generate`   | Regenerate the Prisma client after editing the schema               |
| `npm run prisma:validate`   | Validate `prisma/schema.prisma`                                     |
| `npm run db:migrate:dev`    | Create and apply a migration in development                         |
| `npm run db:migrate:deploy` | Apply pending migrations (CI, Docker, production)                   |
| `npm run db:migrate:check`  | Fail if the migrated database and `schema.prisma` differ (CI)       |

## Configuration

All configuration comes from environment variables. In local development they are read from
`.env`; variables already set in the environment take precedence. The app validates them at
startup and exits with an error that names each invalid variable without printing its value.

The **Used by** column says which processes read a variable: `all` means the API, the standalone
worker and the operator CLI; `api` means the HTTP process only. The worker and the CLI do not
validate API-only settings, so a worker container does not need them.

| Variable                                  | Used by | Default         | Description                                                                            |
| ----------------------------------------- | ------- | --------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                            | all     | required        | PostgreSQL connection string (`postgresql://...`)                                      |
| `NODE_ENV`                                | all     | `development`   | `development` (readable logs), `test` or `production` (JSON logs)                      |
| `PAYMENT_SIMULATOR_OUTCOME`               | all     | `SUCCEEDED`     | Simulator result for every payment: `SUCCEEDED`, `DECLINED`, `UNAVAILABLE`             |
| `PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS` | all     | `false`         | `true`: submissions are processed but time out; outcomes come from lookup              |
| `OUTBOX_POLL_INTERVAL_MS`                 | all     | `1000`          | Idle delay between outbox polls (100-60000)                                            |
| `OUTBOX_LEASE_SECONDS`                    | all     | `60`            | How long a claimed job is owned before another worker may take it (≥ 30)               |
| `OUTBOX_MAX_RUNS`                         | all     | `10`            | Runs per job before it is parked as `DEAD` for investigation                           |
| `OUTBOX_BACKOFF_MAX_SECONDS`              | all     | `300`           | Cap for the exponential retry delay (2 s, 4 s, 8 s, ...)                               |
| `RECONCILIATION_DELAY_SECONDS`            | all     | `60`            | Wait before the first lookup of an unknown outcome; also the stale-attempt age         |
| `PAYGUARD_OPERATOR`                       | CLI     | `<user>@<host>` | Actor recorded in the audit trail for CLI actions (printable ASCII, ≤ 200)             |
| `PORT`                                    | api     | `3000`          | HTTP port                                                                              |
| `SWAGGER_ENABLED`                         | api     | `false`         | `true` serves Swagger UI at `/docs`                                                    |
| `CORS_ALLOWED_ORIGINS`                    | api     | empty           | Comma-separated exact origins; empty sends no CORS headers                             |
| `OUTBOX_WORKER_ENABLED`                   | api     | `true`          | Also run the worker inside the API process; `false` when a standalone worker runs      |
| `RATE_LIMIT_IP_PER_MINUTE`                | api     | `300`           | Requests per client IP per minute, all routes except health checks                     |
| `RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE`   | api     | `60`            | Payment creations and retries per merchant per minute                                  |
| `TRUSTED_PROXIES`                         | api     | empty           | Proxy addresses allowed to set `X-Forwarded-For` (see [Rate limiting](#rate-limiting)) |
| `HEALTH_QUEUE_BACKLOG_SECONDS`            | api     | `120`           | `/health` queue check: age at which due jobs or expired leases count as stuck (≥ 10)   |
| `HEALTH_WORKER_TIMEOUT_SECONDS`           | api     | `30`            | `/health` worker check: heartbeat age after which a worker counts as gone (≥ 20)       |
| `TEST_DATABASE_URL`                       | tests   | required        | Database for `npm run test:e2e`; its name must end with `_test`                        |
| `POSTGRES_USER` / `_PASSWORD` / `_DB`     | Compose | required        | Credentials for the Compose PostgreSQL container                                       |
| `POSTGRES_HOST_PORT` / `API_HOST_PORT`    | Compose | `5432`/`3000`   | Host ports published by Compose (bound to 127.0.0.1)                                   |

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
  reconciliation and a late result race, exactly one is applied.
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
# hour, the last error category of unfinished jobs, every known worker (active, silent or stopped),
# and the dead jobs with their payment and attempt.
npm run admin -- ops:status

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
`quantile`), never from IDs, merchants or free text, so the series count is bounded. Values
describe the rows currently retained, so outbox counts and sums can drop after
`maintenance:prune`; alert on levels and short-window increases rather than on lifetime totals.

| Metric                                                    | Labels                     | Meaning                                                       |
| --------------------------------------------------------- | -------------------------- | ------------------------------------------------------------- |
| `payguard_outbox_jobs`                                    | `type`, `status`           | Jobs by type and status                                       |
| `payguard_outbox_dead_jobs`                               |                            | Jobs parked as `DEAD`                                         |
| `payguard_outbox_expired_leases`                          |                            | `PROCESSING` jobs whose lease has expired                     |
| `payguard_outbox_oldest_due_job_age_seconds`              |                            | How long the oldest due job has waited                        |
| `payguard_outbox_lease_recoveries`                        |                            | Takeovers of expired leases, summed over retained jobs        |
| `payguard_outbox_unfinished_jobs_by_last_error`           | `category`                 | Unfinished jobs by sanitized last error                       |
| `payguard_reconciliation_lookup_runs`                     |                            | Lookup runs, summed over retained reconciliation jobs         |
| `payguard_payment_attempts`                               | `status`, `failure_code`   | Attempts by status and failure code (`none` when unset)       |
| `payguard_payment_attempts_unresolved`                    |                            | Attempts still `PENDING`                                      |
| `payguard_payment_attempts_oldest_unresolved_age_seconds` |                            | Age of the oldest `PENDING` attempt                           |
| `payguard_payment_retries`                                |                            | Accepted retry requests                                       |
| `payguard_payment_attempt_settle_seconds`                 | `quantile` (`0.5`, `0.95`) | Creation-to-outcome time of attempts settled in the last hour |
| `payguard_workers_active`                                 |                            | Workers with a heartbeat in the last 30 s                     |
| `payguard_worker_last_heartbeat_age_seconds`              |                            | Newest heartbeat age (`-1`: no worker has ever reported)      |
| `payguard_worker_last_job_finished_age_seconds`           |                            | Time since any worker last finished a job (`-1`: never)       |

Request rates and latencies are not exported; derive them from the access log (one JSON line per
request with status and duration) or from the proxy in front of the API.

### Alerting recommendations

These are starting points, not tuned values; nothing in PayGuard sends alerts itself. Adjust them
to observed traffic.

| Condition                                                                               | Suggested threshold  | Why                                                     |
| --------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| `payguard_workers_active == 0`                                                          | for 2 minutes        | Nothing is processing payments                          |
| `payguard_outbox_dead_jobs > 0`                                                         | immediately          | Every dead job needs an operator decision               |
| `payguard_outbox_oldest_due_job_age_seconds`                                            | > 120 for 5 minutes  | Workers are down, overloaded or failing                 |
| `payguard_payment_attempts_oldest_unresolved_age_seconds`                               | > 900                | Outcomes are unknown beyond the automatic lookup window |
| `payguard_outbox_expired_leases > 0`                                                    | for 5 minutes        | Workers are dying or hanging mid-job                    |
| Increase in `payguard_outbox_lease_recoveries`                                          | > 5 in 15 minutes    | Possible poison job or crash-looping worker             |
| `payguard_payment_attempts{status="FAILED",failure_code="PROVIDER_UNAVAILABLE"}` rising | sustained            | Provider outage                                         |
| `payguard_payment_attempt_settle_seconds{quantile="0.95"}`                              | > 30                 | Processing is slow                                      |
| `GET /health` returns 503                                                               | 2 consecutive probes | Instance cannot reach PostgreSQL                        |

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

### Data retention

Nothing is deleted automatically. The defaults keep everything:

| Data                                                     | Retention                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Payments, attempts, idempotency keys, retry requests     | Indefinitely. They are the financial record, and deleting an idempotency key would let a replay create a second payment. |
| Audit events                                             | Indefinitely, and the table rejects deletes                                                                              |
| Merchants and API keys                                   | Indefinitely; merchants are suspended and keys revoked, never deleted                                                    |
| `COMPLETED` outbox jobs of attempts with a final outcome | Prunable on demand                                                                                                       |
| Worker heartbeat rows                                    | Prunable on demand                                                                                                       |
| `DEAD` jobs and jobs of `PENDING` attempts               | Never pruned: they are the evidence for unresolved work                                                                  |

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

| Entry point         | Root module    | Contains                                                                      |
| ------------------- | -------------- | ----------------------------------------------------------------------------- |
| `dist/main.js`      | `AppModule`    | HTTP API, guards, health; the worker too unless `OUTBOX_WORKER_ENABLED=false` |
| `dist/worker.js`    | `WorkerModule` | Outbox worker, job processor and payment provider only; no HTTP server        |
| `dist/cli/admin.js` | `AdminModule`  | Merchant, key, outbox and audit services for the operator CLI                 |

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
├── payments/               # /v1/payments and retries, lifecycle, idempotency, currencies
│   ├── processing/         # Outbox worker, process/reconcile job handlers, in-process starter
│   └── providers/          # PaymentProvider port, the simulated provider and its module
├── outbox/                 # Outbox job store: enqueue, claim, fencing, heartbeats, stats, pruning
├── cli/                    # Operator CLI (admin.ts entry point, admin-cli.ts commands, metrics)
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
test/                       # Integration and HTTP tests against real PostgreSQL
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

  Unexpected errors become a generic 500 with the stack trace logged server-side. `path` never
  includes the query string.

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
- Tests swap the provider through `createTestApp({ provider })`. The `ScriptedProvider` test
  double keeps a ledger of what it "processed", can lose answers, fail or hold a call open, and
  counts submissions and lookups. Tests drive the worker directly (`processDueJobs()`), and move
  time by editing timestamps in the test database, so none of them sleep. Failures are injected
  with temporary triggers in that database.

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
2. **docker**: builds the runtime image so Dockerfile changes are verified.

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
  - webhook handling (signature verification, deduplication, the same conditional outcome
    writes) if the provider pushes results;
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
- **No push notifications.** Clients poll `GET /v1/payments/:id` for outcomes; there are no
  webhooks.
- **Retention is manual.** Payments, attempts, idempotency keys and audit events grow without
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

| Symptom                                                      | Fix                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Missing API key`                                        | Send `Authorization: Bearer <key>`. Keys in query strings are ignored by design.                                                                                                                                                                                  |
| `401 Invalid API key` with a key you just created            | Check for truncation or extra whitespace, then `key:list` for its status and `merchant:list` for suspension. The server log names the rejection reason.                                                                                                           |
| `400` with `field: "Idempotency-Key"`                        | Send an `Idempotency-Key` header of 1-255 visible ASCII characters (no spaces).                                                                                                                                                                                   |
| `409 Idempotency-Key has already been used...`               | The key belongs to an earlier operation with a different request. Use a new key for a new operation, or resend the original request to read the result.                                                                                                           |
| `429 Rate limit exceeded`                                    | Wait `Retry-After` seconds. If every client is limited together behind a proxy, list the proxy's address in `TRUSTED_PROXIES`.                                                                                                                                    |
| A payment stays `PENDING`                                    | Check `ops:status`: no active worker or a growing backlog means no worker is running (start `worker`, or set `OUTBOX_WORKER_ENABLED=true`); a dead reconcile job means the provider never gave a definite answer (see [Payment processing](#payment-processing)). |
| `/health` shows `workers` with `no_active_worker`            | No worker has sent a heartbeat within `HEALTH_WORKER_TIMEOUT_SECONDS`. With the API's worker disabled, check that the `worker` service is running and can reach PostgreSQL (`docker compose logs worker`).                                                        |
| `/health` shows `queue` with `dead_jobs`                     | Run `ops:status` for the dead jobs, then follow [Payment processing](#payment-processing).                                                                                                                                                                        |
| `TRUSTED_PROXIES must be comma-separated IP addresses ...`   | Use IPs, CIDR ranges with a prefix of at least 1, or `loopback`/`linklocal`/`uniquelocal`. `0.0.0.0/0` is rejected on purpose.                                                                                                                                    |
| `TRUST_PROXY_HOPS` has no effect                             | It is not a PayGuard setting; use `TRUSTED_PROXIES`.                                                                                                                                                                                                              |
| `maintenance:prune` refuses a value                          | Retention must be at least 7 days and the batch size 1-10000.                                                                                                                                                                                                     |
| `409 Payment cannot be retried: <reason>`                    | Only `FAILED` payments with fewer than 3 attempts can be retried; a `PENDING` payment is still being processed or reconciled.                                                                                                                                     |
| `Refusing to run integration tests against "..."`            | `TEST_DATABASE_URL` must point at a database whose name ends with `_test`.                                                                                                                                                                                        |
| `TEST_DATABASE_URL must be set to run integration tests`     | Add `TEST_DATABASE_URL` to `.env` (see `.env.example`).                                                                                                                                                                                                           |
| `database "payguard_test" does not exist`                    | The init script runs only on a fresh volume. Run `docker compose exec postgres createdb -U payguard payguard_test`, or reset with `docker compose down -v`.                                                                                                       |
| `Property 'merchant' does not exist on type 'PrismaService'` | The generated client is stale. Run `npm run prisma:generate`.                                                                                                                                                                                                     |
| `Bind for 127.0.0.1:5432 failed: port is already allocated`  | Another PostgreSQL is running. Set `POSTGRES_HOST_PORT` (e.g. `5434`) in `.env` and update the port in both database URLs.                                                                                                                                        |
| `EADDRINUSE` on start                                        | Change `PORT` (local) or `API_HOST_PORT` (Compose) in `.env`.                                                                                                                                                                                                     |
| `Invalid environment configuration: ...`                     | The listed variables are missing or malformed. Compare `.env` with `.env.example`.                                                                                                                                                                                |
| `/health` returns 503 with `Database is unreachable`         | Check that PostgreSQL is running and that `DATABASE_URL` matches the Compose credentials. The server log has the real error.                                                                                                                                      |
| Database authentication fails although the password is right | URL-encode special characters in the password inside `DATABASE_URL` (e.g. `@` → `%40`).                                                                                                                                                                           |
| `ExperimentalWarning: VM Modules is an experimental feature` | Expected: Jest's ESM mode prints this. It is harmless.                                                                                                                                                                                                            |
| Prisma suggests updating to `8.0.0-rc.*`                     | Ignore it. Prisma publishes release candidates under its `latest` tag, and this project pins the stable 7.10.1.                                                                                                                                                   |
| Prettier reports every file as changed on Windows            | Line endings: `.gitattributes` enforces LF. Re-checkout, or set `git config core.autocrlf false`.                                                                                                                                                                 |
