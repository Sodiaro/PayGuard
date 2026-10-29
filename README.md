# PayGuard

PayGuard is a payment-processing backend built around the failures that make payments hard: a
client retrying a request it thinks was lost, two identical requests racing, a provider call
that times out after the money may already have moved, a worker dying mid-job, and webhooks
arriving twice, late or out of order. Merchants create payments over an HTTP API; workers process
them asynchronously through a PostgreSQL outbox; operators can see, for every payment, what
happened and on what evidence.

Payments are processed by a deterministic simulator. No real provider is connected and no money
moves; see [Limitations](#limitations).

## Key engineering features

- **Idempotency enforced by the database.** Every `POST` requires an `Idempotency-Key`. The
  validated request is reduced to a versioned canonical fingerprint and stored under a unique
  `(merchant_id, idempotency_key)` constraint. Concurrent duplicates race on that insert and the
  losers are answered from the winner's row: the same request replays the current state (`200`,
  `Idempotent-Replayed: true`), a different request with the same key gets `409`.
- **Guarded payment lifecycle.** A payment (what the merchant asked for) and its attempts (each
  try at the provider) are separate records. Every status write is a conditional
  `UPDATE ... WHERE status IN (...)` derived from one transition table, and a partial unique index
  allows one pending attempt per payment, so a late or conflicting result cannot overwrite a
  terminal state and a retry cannot run alongside an attempt in flight.
- **Durable asynchronous processing.** The payment, its attempt and its outbox job commit in one
  transaction, so accepted work cannot be lost. Workers claim jobs with
  `FOR UPDATE SKIP LOCKED` under a lease, and every write is fenced by the lease token, so a worker
  that stalled and lost its lease cannot complete the job. Failures back off exponentially; jobs
  that exhaust their runs are parked as `DEAD` and reported, never dropped.
- **Ambiguous outcomes are reconciled, not guessed.** An attempt is marked submitted before the
  provider is called. A timeout or unrecognised answer leaves it `PENDING` and schedules a lookup;
  the attempt is resubmitted only if the provider reports no record of it, and then under the same
  attempt ID, which is the provider-side idempotency key.
- **Webhooks treated as signed claims, not commands.** The HMAC-SHA256 signature is verified over
  the raw bytes before parsing, with a timestamp tolerance. Events are deduplicated on
  `(provider, event_id)` plus a canonical content hash, stored together with their processing job
  before the `202`, and applied by a worker through the same guarded writes as every other
  outcome. Duplicate, late and contradictory events cannot change a recorded outcome; events whose
  amount or content cannot be trusted defer to a provider lookup.
- **Diagnosable state.** An append-only payment history, written in the same transaction as each
  change, records every transition and its evidence: provider response, lookup, webhook, worker
  decision or operator action. CLI commands list unresolved attempts with the reason each is
  stuck, flag contradictory provider answers, and audit every operator action.
- **Least-privilege database access.** The API and worker, the operator CLI and migrations connect
  as three different PostgreSQL roles. The runtime role cannot delete rows or read the audit trail,
  and no application role can modify history.

## Architecture and design decisions

```
HTTP API ──► one transaction: payment + attempt + outbox job ──► 202 PENDING
                                     │
Worker(s) ── claim (SKIP LOCKED, lease) ──► provider ──► guarded outcome write + history
                                     │
                 no definite answer ──► delayed lookup ──► resolve, or retry with backoff
Webhook ──► verify ──► store event + job ──► 202 ──► worker applies through the same guards
```

- **PostgreSQL is the only coordination point.** The outbox, leases, heartbeats, deduplication
  and history all live in the database that holds the payments, so enqueueing work is part of the
  transaction that creates it. There is no broker whose state can disagree with the database. The
  trade-off is throughput bounded by one PostgreSQL instance, which has not been benchmarked.
- **Unknown is a real state.** A payment whose outcome the provider has not confirmed stays
  `PENDING`. It is never reported as failed (which would invite a retry and a second charge), and
  there is deliberately no command to set an outcome by hand; operators requeue the lookup once
  the provider can answer.
- **Scheduling uses the database clock.** When a job is due, when a lease expires and whether a
  worker is alive are computed with PostgreSQL's `now()`, so application hosts with drifting
  clocks cannot make work run early or stall.
- **One image, three entry points.** A modular NestJS monolith starts as the API, a standalone
  worker or the operator CLI. The worker can also run inside the API process; correctness does not
  depend on how many workers run or where.
- **The guarantee has a stated boundary.** Database constraints prevent duplicate payments,
  attempts and jobs; the outbox gives at-least-once processing; the submission marker and lookups
  prevent blind resubmission. Together these give at most one charge per attempt only if the
  provider honours the attempt ID as an idempotency key. PayGuard does not claim exactly-once
  processing.

Details: [docs/architecture.md](docs/architecture.md).

## Technology stack

- Node.js 24, TypeScript, NestJS 12 (native ES modules)
- PostgreSQL 18, Prisma 7 with the `pg` driver adapter
- Jest (unit, integration and soak tests)
- Docker Compose, GitHub Actions

## Getting started

Requires Node.js 24, npm 11 and Docker with Compose v2.

```bash
cp .env.example .env               # then replace every "change-me" value
npm ci                             # installs dependencies and generates the Prisma client
docker compose up -d postgres      # first start provisions the roles and databases
npm run db:migrate:deploy          # applies migrations as the schema owner
npm run admin -- merchant:create --name "Acme Ltd"   # prints the merchant's API key once
npm run start:dev                  # API on PORT (3000), with the worker in-process
```

To run the whole stack in containers instead, with the worker as its own service:
`docker compose up --build`, then `docker compose run --rm cli merchant:create --name "Acme Ltd"`.
See [docs/development.md](docs/development.md) for details and every command.

## Example API usage

```bash
curl -X POST http://localhost:3000/v1/payments \
  -H "Authorization: Bearer pgsk_0123456789abcdef_REPLACE_WITH_YOUR_SECRET" \
  -H "Idempotency-Key: 6f1c1a0e-2b9e-4c1e-9d55-0b2f3c7a9e10" \
  -H "Content-Type: application/json" \
  -d '{"amount": 500000, "currency": "NGN", "reference": "order_10042"}'
```

The response is `202 Accepted` with the payment `PENDING` and its first attempt queued. Amounts
are integers in the currency's minor unit (`500000` is NGN 5,000.00). A worker processes the
attempt, normally within a second, and the result appears on
`GET /v1/payments/{id}` as `SUCCEEDED` or `FAILED` with a failure code, along with each attempt.
If the provider's answer was lost, the payment stays `PENDING` until reconciliation establishes
the outcome.

Sending the same request again with the same `Idempotency-Key` creates nothing and returns the
payment's current state with `Idempotent-Replayed: true`. Reusing the key for a different request
returns `409`. A failed payment can be retried with `POST /v1/payments/{id}/retry`, which adds an
attempt under its own idempotency key. Full contract: [docs/api.md](docs/api.md).

## Testing and reliability

```bash
npm test                 # unit tests, no database
npm run test:e2e         # integration tests against PostgreSQL, under the deployed roles
npm run test:soak        # opt-in concurrency soak with real worker processes
npm run smoke:docker     # builds the images and exercises the full Compose stack
```

- **Integration tests** run against real PostgreSQL with the same database privileges as
  deployment. They cover concurrent duplicate requests, competing workers, lease expiry and
  fencing, injected database failures mid-transaction, reconciliation racing late results and
  webhooks, out-of-order and contradictory webhooks, and the application clock running two
  minutes ahead of or behind the database's. Time is moved in the database rather than slept.
- **The soak test** runs concurrent clients against the API and several worker processes, kills a
  worker mid-run, then checks with SQL that every attempt was submitted once and resolved once and
  that payments, attempts, retries and webhook events are consistent. It checks correctness under
  concurrency on one machine; it is not a performance benchmark.
- **The Docker smoke test** builds the images, runs payments through the standalone worker,
  webhooks and reconciliation, and confirms that a production configuration refuses to start,
  that the containers connect as the runtime role, and that no secret reaches the logs.

CI runs formatting, lint, type checks, unit tests, migrations, a schema drift check, integration
tests and the Docker smoke test on pushes to `main` and on pull requests. All of this exercises the
simulator, so it shows how PayGuard behaves against a provider that honours idempotency, not how
any real provider behaves. Details: [docs/testing.md](docs/testing.md).

## Limitations

- **Simulated payments only.** There is no real provider integration, card handling, capture,
  refund or payout, and no money moves. The simulator is refused when `NODE_ENV=production`, so
  the API and worker cannot run in production until a real provider is implemented.
- **At most one charge per attempt depends on the provider** deduplicating by attempt ID and
  answering lookups consistently. The simulator does by construction; a real provider would have
  to be verified.
- **Automatic reconciliation is bounded.** An outcome still unknown after the configured lookups
  stays `PENDING` and needs an operator, who can only requeue the lookup.
- **No outbound notifications.** Merchants poll for outcomes.
- **Rate limits are per process**, and capacity has not been measured.
- **History is append-only, not tamper-proof.** Application roles cannot change it; the schema
  owner and superusers can.

The full list is in [docs/architecture.md](docs/architecture.md#limitations).

## Documentation

- [Architecture](docs/architecture.md): modules, payment lifecycle, processing and recovery,
  webhook processing, API keys, database roles, conventions
- [API](docs/api.md): authentication, payments, idempotency, currencies, webhooks, rate limits,
  errors
- [Configuration](docs/configuration.md): environment variables, environments, simulator, proxies
- [Development](docs/development.md): detailed setup, Docker Compose stack, commands
- [Operations](docs/operations.md): operator CLI, investigating payments, health, metrics,
  alerting, audit, retention, database role provisioning, troubleshooting
- [Testing](docs/testing.md): test layers, test database, soak and smoke tests, CI
