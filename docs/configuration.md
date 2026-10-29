# Configuration

All configuration comes from environment variables. In local development they are read from
`.env` (start from `.env.example`); variables already set in the environment take precedence.
Each process validates its own settings at startup and exits with an error that names each
invalid variable without printing its value.

- [Environment variables](#environment-variables)
- [Development, test and production](#development-test-and-production)
- [Payment simulator](#payment-simulator)
- [Client IP behind a proxy](#client-ip-behind-a-proxy)

How the Docker Compose stack wires these settings is described in
[development.md](development.md#docker-compose-stack).

## Environment variables

The **Used by** column says which processes read a variable: `all` means the API, the standalone
worker and the operator CLI; `api` means the HTTP process only. A worker container needs no
API-only settings and the CLI needs no provider.

| Variable                                                                         | Used by               | Default         | Description                                                                                 |
| -------------------------------------------------------------------------------- | --------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                       | all                   | required        | `development` (readable logs), `test` or `production` (JSON logs). No default               |
| `PAYMENT_PROVIDER`                                                               | api, worker           | required        | The payment provider. Only `simulator` exists, and it is refused when `NODE_ENV=production` |
| `DATABASE_URL`                                                                   | api, worker           | required        | Connection as the runtime role (`payguard_app`)                                             |
| `OPERATOR_DATABASE_URL`                                                          | CLI                   | required        | Connection as the operator role (`payguard_cli`); the CLI never uses `DATABASE_URL`         |
| `MIGRATION_DATABASE_URL`                                                         | migrations            | required        | Connection as the schema owner (`payguard_owner`), used only by `npm run db:migrate:*`      |
| `PAYMENT_SIMULATOR_OUTCOME`                                                      | all                   | `SUCCEEDED`     | Simulator result for every payment: `SUCCEEDED`, `DECLINED`, `UNAVAILABLE`                  |
| `PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS`                                        | all                   | `false`         | `true`: submissions are processed but time out; outcomes come from lookup                   |
| `OUTBOX_POLL_INTERVAL_MS`                                                        | all                   | `1000`          | Idle delay between outbox polls (100-60000)                                                 |
| `OUTBOX_LEASE_SECONDS`                                                           | all                   | `60`            | How long a claimed job is owned before another worker may take it (≥ 30)                    |
| `OUTBOX_MAX_RUNS`                                                                | all                   | `10`            | Runs per job before it is parked as `DEAD` for investigation                                |
| `OUTBOX_BACKOFF_MAX_SECONDS`                                                     | all                   | `300`           | Cap for the exponential retry delay (2 s, 4 s, 8 s, ...)                                    |
| `RECONCILIATION_DELAY_SECONDS`                                                   | all                   | `60`            | Wait before the first lookup of an unknown outcome; also the stale-attempt age              |
| `PAYGUARD_OPERATOR`                                                              | CLI                   | `<user>@<host>` | Actor recorded in the audit trail for CLI actions (printable ASCII, ≤ 200)                  |
| `SIMULATOR_WEBHOOK_SECRET`                                                       | api, CLI              | unset           | Webhook signing secret, 32-256 visible ASCII, not an API key; unset disables webhooks       |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`                                            | api                   | `300`           | Allowed difference between a webhook's signed timestamp and the clock (30-900)              |
| `PORT`                                                                           | api                   | `3000`          | HTTP port                                                                                   |
| `SWAGGER_ENABLED`                                                                | api                   | `false`         | `true` serves Swagger UI at `/docs`                                                         |
| `CORS_ALLOWED_ORIGINS`                                                           | api                   | empty           | Comma-separated exact origins; empty sends no CORS headers                                  |
| `OUTBOX_WORKER_ENABLED`                                                          | api                   | `true`          | Also run the worker inside the API process; `false` when a standalone worker runs           |
| `RATE_LIMIT_IP_PER_MINUTE`                                                       | api                   | `300`           | Requests per client IP per minute, all routes except health checks                          |
| `RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE`                                          | api                   | `60`            | Payment creations and retries per merchant per minute                                       |
| `TRUSTED_PROXIES`                                                                | api                   | empty           | Proxy addresses allowed to set `X-Forwarded-For` (see [below](#client-ip-behind-a-proxy))   |
| `HEALTH_QUEUE_BACKLOG_SECONDS`                                                   | api                   | `120`           | `/health` queue check: age at which due jobs or expired leases count as stuck (≥ 10)        |
| `HEALTH_WORKER_TIMEOUT_SECONDS`                                                  | api                   | `30`            | `/health` worker check: heartbeat age after which a worker counts as gone (≥ 20)            |
| `TEST_DATABASE_URL`, `TEST_OPERATOR_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL` | tests                 | required        | The three connections for `npm run test:e2e`, to one database whose name ends with `_test`  |
| `POSTGRES_USER` / `_PASSWORD` / `_DB`                                            | Compose               | required        | The container's bootstrap superuser, used only to provision the roles                       |
| `PAYGUARD_OWNER_PASSWORD` / `_APP_` / `_CLI_`                                    | Compose, provisioning | required        | Passwords given to `payguard_owner`, `payguard_app` and `payguard_cli`                      |
| `POSTGRES_HOST_PORT` / `API_HOST_PORT`                                           | Compose               | `5432`/`3000`   | Host ports published by Compose (bound to 127.0.0.1)                                        |

Each role's password must match in `PAYGUARD_*_PASSWORD` and in every URL that uses that role.
URL-encode special characters in passwords (e.g. `@` → `%40`). The roles themselves are described
in [architecture.md](architecture.md#database-roles).

## Development, test and production

- **Development:** `NODE_ENV=development` and `PAYMENT_PROVIDER=simulator`, as in `.env.example`.
- **Tests:** `test/setup-env.ts` sets `NODE_ENV=test` and `PAYMENT_PROVIDER=simulator` itself, and
  points all three connections at the `_test` database.
- **Production:** `NODE_ENV=production` must be set explicitly, and `PAYMENT_PROVIDER` must name a
  real provider. None exists yet, so a production configuration of the API or worker exits at
  startup, before accepting work, with an error naming the variable. The simulator has no
  production override. The CLI does not load a provider and runs in any environment, but its
  `simulator:webhook` command is refused in production.

## Payment simulator

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

## Client IP behind a proxy

By default the TCP peer address is the client and `X-Forwarded-For` is ignored, so it cannot be
spoofed. Behind a reverse proxy or load balancer, list the proxy addresses in `TRUSTED_PROXIES`
(comma-separated IPs, CIDR ranges, or `loopback`, `linklocal`, `uniquelocal`):

```bash
TRUSTED_PROXIES=10.0.0.0/8          # proxies on the private network
TRUSTED_PROXIES=loopback            # a proxy on the same host
```

The client IP is then the right-most `X-Forwarded-For` entry that is not a trusted proxy, so a
value a client prepends itself is skipped. Trust is decided by the address of the peer, never by
a hop count: a client that connects directly is never trusted, whatever header it sends. List
only real proxies; `0.0.0.0/0`, `::/0` and any other `/0` range are rejected at startup.
