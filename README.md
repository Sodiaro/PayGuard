# PayGuard

Payment Processing & Transaction Reliability API, built with NestJS, PostgreSQL and Prisma.

> **Status: Stage 2 (merchant identity and API-key authentication).** Merchants, API keys, an
> operator CLI, authenticated `/v1` routes, HTTP security headers and structured logging are in
> place. There are no payment features yet, and the service is **not production-ready** (see
> [Security limitations](#security-limitations)).

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

# 6. Run the API in watch mode.
npm run start:dev
```

Then call the API with the key from step 5:

```bash
curl -H "Authorization: Bearer pgsk_0123456789abcdef_REPLACE_WITH_YOUR_SECRET" \
  http://localhost:3000/v1/merchants/me
```

- `GET /health` and `GET /health/live`: readiness and liveness (no authentication)
- `/docs`: Swagger UI when `SWAGGER_ENABLED=true`; use **Authorize** to send a key

### Run the whole stack in Docker

```bash
docker compose up --build
docker compose exec api node dist/cli/admin.js merchant:create --name "Acme Ltd"
```

This starts PostgreSQL, runs a one-off `migrate` job (`prisma migrate deploy`), and then starts the
API from the production image on `127.0.0.1:${API_HOST_PORT}`. In the container, run the admin CLI
with `node dist/cli/admin.js` (there is no npm or TypeScript in the runtime image). Stop the stack
with `docker compose down`; add `-v` to delete the database volume as well.

## Commands

| Command                     | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `npm run start:dev`         | Start the API with file watching                                    |
| `npm run build`             | Compile to `dist/`                                                  |
| `npm run start:prod`        | Run the compiled app (`node dist/main.js`)                          |
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

| Variable                               | Required | Default       | Description                                                       |
| -------------------------------------- | -------- | ------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`                         | yes      | none          | PostgreSQL connection string (`postgresql://...`)                 |
| `NODE_ENV`                             | no       | `development` | `development` (readable logs), `test` or `production` (JSON logs) |
| `PORT`                                 | no       | `3000`        | HTTP port                                                         |
| `SWAGGER_ENABLED`                      | no       | `false`       | `true` serves Swagger UI at `/docs`                               |
| `CORS_ALLOWED_ORIGINS`                 | no       | empty         | Comma-separated exact origins; empty sends no CORS headers        |
| `TEST_DATABASE_URL`                    | tests    | none          | Database for `npm run test:e2e`; its name must end with `_test`   |
| `POSTGRES_USER` / `_PASSWORD` / `_DB`  | Compose  | none          | Credentials for the Compose PostgreSQL container                  |
| `POSTGRES_HOST_PORT` / `API_HOST_PORT` | no       | `5432`/`3000` | Host ports published by Compose (bound to 127.0.0.1)              |

## Merchants and API keys

### Data model

| Table               | Purpose and notable constraints                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merchants`         | UUIDv7 `id`, unique `slug`, `name`, `status` (`ACTIVE`/`SUSPENDED`), timestamps. The unique slug is the provisioning idempotency key: a retried or concurrent `merchant:create` fails instead of creating a duplicate. |
| `merchant_api_keys` | UUIDv7 `id`, `merchant_id` (indexed, `ON DELETE RESTRICT`), unique `prefix`, `secret_hash` (`bytea`), optional `label` and `expires_at`, `revoked_at`, `created_at`.                                                   |

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

### Authentication in the application

- `ApiKeyGuard` is registered globally (`APP_GUARD`), so every route requires a key unless it is
  marked `@Public()`. Today only the health controller is public; Swagger UI is served outside the
  Nest router.
- Keys are accepted only in the `Authorization: Bearer` header, never in query strings or bodies.
- Controllers get the caller from `@CurrentMerchant()`, which returns `{ merchantId, apiKeyId }`
  set by the guard. **Never take a merchant ID from the path, query, headers or body.** Services
  scope every query by that `merchantId`, so another merchant's resource behaves exactly like one
  that does not exist (404). `GET /v1/api-keys/:id` is the reference implementation.

Endpoints in this stage:

| Method and path        | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `GET /v1/merchants/me` | The merchant that owns the presented key                     |
| `GET /v1/api-keys`     | The caller's keys (prefix, label, status, dates; no secrets) |
| `GET /v1/api-keys/:id` | One of the caller's keys; 404 for anyone else's              |

There are deliberately no HTTP endpoints for registering merchants or managing keys.

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
confirm traffic uses it → `key:revoke` the old key. If it is unclear when every consumer has
switched, give the new key time to roll out first and revoke the old one afterwards.

**Responding to a leaked key:** `key:revoke` it immediately; it stops working on the next
request. `merchant:suspend` blocks all of a merchant's keys at once while you investigate.

## Architecture

PayGuard is a **modular monolith**: one deployable NestJS application made of feature modules
with explicit boundaries. Each module owns its controllers, services and persistence code, and
other modules use it only through the providers it exports.

```
src/
├── main.ts                 # Entry point: logger, HTTP setup, Swagger toggle, shutdown hooks
├── app.module.ts           # Root module: config + infrastructure + feature modules
├── app.setup.ts            # HTTP pipeline shared by main.ts and integration tests
├── auth/                   # Key format, authenticator, global guard, @Public/@CurrentMerchant
├── merchants/              # Merchant and key services, /v1/merchants and /v1/api-keys
├── cli/                    # Operator CLI (admin.ts entry point, admin-cli.ts commands)
├── config/                 # Environment schema, validation and ConfigModule
├── common/http/            # Error format, exception filter, request IDs, validation
├── common/logging/         # Structured logger, request context, access log
├── database/               # PrismaService (pg driver adapter) and DatabaseModule
├── health/                 # /health (readiness) and /health/live (liveness)
└── generated/prisma/       # Generated Prisma client (gitignored; created by npm install)
prisma/
├── schema.prisma
└── migrations/
test/                       # Integration and HTTP tests against real PostgreSQL
```

Next modules: `payments` (payments and attempts), `providers` (adapters and simulation),
`webhooks`, `reconciliation` and `audit`.

### Conventions

- **Layers.** Controllers handle HTTP only: routing, DTO validation and status codes. Services
  hold the logic and throw domain errors (e.g. `MerchantNotFoundError`) that controllers and the
  CLI translate. Persistence goes through `PrismaService`.
- **Configuration.** Read config through `ConfigService<EnvironmentVariables, true>`, never
  through `process.env`. To add a variable, declare it in `src/config/environment.ts` and
  `.env.example`.
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
- **Health.** `/health/live` checks only the process; `/health` also pings PostgreSQL and returns
  503 when it is unreachable, with the real error in the server log only.

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

- **Unit tests** (`src/**/*.spec.ts`): key generation, parsing and comparison; guard behaviour for
  every rejection path; log redaction; configuration; input validation; HTTP conventions. No
  database needed.
- **Integration and HTTP tests** (`test/**/*.e2e-spec.ts`) run against **real PostgreSQL**:
  provisioning (including concurrent duplicates), revocation, expiry, suspension, multiple keys,
  the CLI, merchant isolation over HTTP, and a check that no key reaches logs or responses.

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

## Security limitations

- **No rate limiting yet.** Brute-forcing a 256-bit secret is infeasible, but unauthenticated
  requests still cost a database lookup. Add throttling at the edge or in the app before exposure.
- **Key usage is not recorded** (no `last_used_at`), so there is no automatic way to tell when a
  rotated-out key has stopped being used.
- **No audit trail** for administrative actions yet; the CLI relies on whoever can reach the
  database. Treat database access as administrative access.
- **Expiry is enforced, but nothing alerts before a key expires.**
- **HTTPS is assumed to terminate in front of the API.** HSTS is sent, but the app itself serves
  plain HTTP.
- **Swagger UI under Helmet's CSP** was checked statically (no inline scripts, all assets
  same-origin), not in a browser.

## Troubleshooting

| Symptom                                                      | Fix                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Missing API key`                                        | Send `Authorization: Bearer <key>`. Keys in query strings are ignored by design.                                                                            |
| `401 Invalid API key` with a key you just created            | Check for truncation or extra whitespace, then `key:list` for its status and `merchant:list` for suspension. The server log names the rejection reason.     |
| `Refusing to run integration tests against "..."`            | `TEST_DATABASE_URL` must point at a database whose name ends with `_test`.                                                                                  |
| `TEST_DATABASE_URL must be set to run integration tests`     | Add `TEST_DATABASE_URL` to `.env` (see `.env.example`).                                                                                                     |
| `database "payguard_test" does not exist`                    | The init script runs only on a fresh volume. Run `docker compose exec postgres createdb -U payguard payguard_test`, or reset with `docker compose down -v`. |
| `Property 'merchant' does not exist on type 'PrismaService'` | The generated client is stale. Run `npm run prisma:generate`.                                                                                               |
| `Bind for 127.0.0.1:5432 failed: port is already allocated`  | Another PostgreSQL is running. Set `POSTGRES_HOST_PORT` (e.g. `5434`) in `.env` and update the port in both database URLs.                                  |
| `EADDRINUSE` on start                                        | Change `PORT` (local) or `API_HOST_PORT` (Compose) in `.env`.                                                                                               |
| `Invalid environment configuration: ...`                     | The listed variables are missing or malformed. Compare `.env` with `.env.example`.                                                                          |
| `/health` returns 503 with `Database is unreachable`         | Check that PostgreSQL is running and that `DATABASE_URL` matches the Compose credentials. The server log has the real error.                                |
| Database authentication fails although the password is right | URL-encode special characters in the password inside `DATABASE_URL` (e.g. `@` → `%40`).                                                                     |
| `ExperimentalWarning: VM Modules is an experimental feature` | Expected: Jest's ESM mode prints this. It is harmless.                                                                                                      |
| Prisma suggests updating to `8.0.0-rc.*`                     | Ignore it. Prisma publishes release candidates under its `latest` tag, and this project pins the stable 7.10.1.                                             |
| Prettier reports every file as changed on Windows            | Line endings: `.gitattributes` enforces LF. Re-checkout, or set `git config core.autocrlf false`.                                                           |
