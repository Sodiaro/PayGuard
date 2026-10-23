# PayGuard

Payment Processing & Transaction Reliability API, built with NestJS, PostgreSQL and Prisma.

> **Status: Stage 1 (foundation).** The project has its application skeleton, configuration,
> database connectivity, health checks, HTTP conventions, tests, Docker setup and CI. There are no
> payment features yet, and the service is **not production-ready**.

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

# 4. Apply database migrations (there are none yet, so this is a no-op for now).
npm run db:migrate:deploy

# 5. Run the API in watch mode.
npm run start:dev
```

Then check:

- `GET http://localhost:3000/health`: readiness, including a database check
- `GET http://localhost:3000/health/live`: liveness
- `http://localhost:3000/docs`: Swagger UI (requires `SWAGGER_ENABLED=true`)

### Run the whole stack in Docker

```bash
docker compose up --build
```

This starts PostgreSQL, runs a one-off `migrate` job (`prisma migrate deploy`), and then starts the
API from the production image on `127.0.0.1:${API_HOST_PORT}`. Stop it with `docker compose down`;
add `-v` to delete the database volume as well.

## Commands

| Command                     | Purpose                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `npm run start:dev`         | Start the API with file watching                                |
| `npm run build`             | Compile to `dist/`                                              |
| `npm run start:prod`        | Run the compiled app (`node dist/main.js`)                      |
| `npm test`                  | Unit tests (no database needed)                                 |
| `npm run test:cov`          | Unit tests with a coverage report in `coverage/`                |
| `npm run test:e2e`          | HTTP integration tests against PostgreSQL (`TEST_DATABASE_URL`) |
| `npm run lint`              | ESLint with type-aware rules (`lint:fix` to auto-fix)           |
| `npm run format:check`      | Check Prettier formatting (`format` to rewrite files)           |
| `npm run typecheck`         | Type-check sources and tests without emitting output            |
| `npm run prisma:generate`   | Regenerate the Prisma client after editing the schema           |
| `npm run prisma:validate`   | Validate `prisma/schema.prisma`                                 |
| `npm run db:migrate:dev`    | Create and apply a migration in development                     |
| `npm run db:migrate:deploy` | Apply pending migrations (CI, Docker, production)               |

## Configuration

All configuration comes from environment variables. In local development they are read from
`.env`; variables already set in the environment take precedence. The app validates them at
startup and exits with an error that names each invalid variable without printing its value.

| Variable                               | Required | Default       | Description                                                  |
| -------------------------------------- | -------- | ------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                         | yes      | none          | PostgreSQL connection string (`postgresql://...`)            |
| `NODE_ENV`                             | no       | `development` | `development`, `test` or `production`                        |
| `PORT`                                 | no       | `3000`        | HTTP port                                                    |
| `SWAGGER_ENABLED`                      | no       | `false`       | `true` serves Swagger UI at `/docs`                          |
| `TEST_DATABASE_URL`                    | tests    | none          | Database used by `npm run test:e2e` (must not be the dev DB) |
| `POSTGRES_USER` / `_PASSWORD` / `_DB`  | Compose  | none          | Credentials for the Compose PostgreSQL container             |
| `POSTGRES_HOST_PORT` / `API_HOST_PORT` | no       | `5432`/`3000` | Host ports published by Compose (bound to 127.0.0.1)         |

## Architecture

PayGuard is a **modular monolith**: one deployable NestJS application made of feature modules
with explicit boundaries. Each module owns its controllers, services and persistence code, and
other modules use it only through the providers it exports. If a module ever needs to become its
own service, it can be extracted then; there is no reason to pay that cost up front.

```
src/
├── main.ts                 # Entry point: bootstrap, Swagger toggle, shutdown hooks
├── app.module.ts           # Root module: config + infrastructure + feature modules
├── app.setup.ts            # HTTP conventions shared by main.ts and integration tests
├── config/
│   └── environment.ts      # Environment schema and startup validation
├── common/http/            # Cross-cutting HTTP concerns
│   ├── error-response.ts   # Standard error body (also documented in OpenAPI)
│   ├── http-exception.filter.ts
│   ├── request-id.middleware.ts
│   └── validation.ts       # Global ValidationPipe and field-level error details
├── database/
│   ├── database.module.ts  # Exports PrismaService; import it where persistence is needed
│   └── prisma.service.ts   # Single Prisma client (pg driver adapter) and pool lifecycle
├── health/                 # /health (readiness) and /health/live (liveness)
└── generated/prisma/       # Generated Prisma client (gitignored; created by npm install)
prisma/
├── schema.prisma           # Data model (no tables yet)
└── migrations/             # Created with the first migration
prisma.config.ts            # Prisma 7 CLI configuration (schema path, DATABASE_URL)
test/                       # HTTP integration tests (Supertest + real PostgreSQL)
```

Later stages will add these modules as siblings of `health/`: `auth` (with merchant management),
`payments` (payments and attempts), `providers` (provider adapters and simulation), `webhooks`,
`reconciliation` and `audit`.

### Conventions

- **Layers.** Controllers handle HTTP only: routing, DTO validation and status codes. Application
  services hold the business logic. Persistence goes through `PrismaService`, wrapped in a
  repository only where that clarifies a module.
- **Configuration.** Read config through `ConfigService<EnvironmentVariables, true>`, never
  through `process.env`. To add a variable, declare it in `src/config/environment.ts` and
  `.env.example`.
- **Versioning.** Business endpoints are served under `/v1/...` (URI versioning). Operational
  endpoints opt out with `VERSION_NEUTRAL`.
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

  Unexpected errors become a generic 500. The stack trace is logged on the server and never sent
  to the client. Request bodies are never logged.

- **Request IDs.** Every response carries an `X-Request-Id` header. The caller's value is reused
  if it is a safe token (up to 128 characters); otherwise a UUID is generated.
- **Health.** `/health/live` checks only the process, so a database outage never causes restarts.
  `/health` also pings PostgreSQL (1 s timeout) and returns 503 when it is unreachable. The
  public response gives a generic reason, and the server log has the actual error. Database
  connections open lazily, so the API starts while PostgreSQL is down, and `/health` recovers
  automatically once the database is back.

### Platform notes

- **NestJS 12 uses native ES modules** (`"type": "module"`). Relative imports therefore need the
  `.js` suffix (`import { X } from './x.js'`), even in TypeScript files.
- **Jest runs in ESM mode** (`--experimental-vm-modules`, ts-jest ESM preset). Test files import
  `describe`, `it`, `expect` and `jest` from `@jest/globals`.
- **Prisma 7** keeps its CLI configuration in `prisma.config.ts`. The client is generated into
  `src/generated/prisma` (not committed) and connects through the `@prisma/adapter-pg` driver
  adapter.

## Testing

- **Unit tests** (`src/**/*.spec.ts`) cover configuration validation, the error filter, request
  validation, request IDs and health-check behaviour, including database failures. They need no
  database.
- **Integration tests** (`test/**/*.e2e-spec.ts`) boot the real application with Supertest
  against **real PostgreSQL**; no in-memory substitute is used. They always use
  `TEST_DATABASE_URL`, so development data is never touched. Locally, start PostgreSQL with
  `docker compose up -d postgres` first.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

1. **verify**: `npm ci` → `format:check` → `lint` → `typecheck` → `prisma:validate` → unit tests
   → `db:migrate:deploy` → integration tests (PostgreSQL 18 service container) → `build`.
2. **docker**: builds the runtime image so Dockerfile changes are verified.

Each CI step calls the same npm scripts you run locally.

## Troubleshooting

| Symptom                                                      | Fix                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bind for 127.0.0.1:5432 failed: port is already allocated`  | Another PostgreSQL is running. Set `POSTGRES_HOST_PORT` (e.g. `5434`) in `.env` and update the port in both database URLs.                                  |
| `EADDRINUSE` on start                                        | Change `PORT` (local) or `API_HOST_PORT` (Compose) in `.env`.                                                                                               |
| `Invalid environment configuration: ...`                     | The listed variables are missing or malformed. Compare `.env` with `.env.example`.                                                                          |
| `Cannot find module '.../generated/prisma/client.js'`        | Run `npm run prisma:generate` (normally done by `npm install`).                                                                                             |
| `/health` returns 503 with `Database is unreachable`         | Check that PostgreSQL is running (`docker compose ps`) and that `DATABASE_URL` matches the Compose credentials. The server log has the real error.          |
| Authentication fails although the password is correct        | URL-encode special characters in the password inside `DATABASE_URL` (e.g. `@` → `%40`).                                                                     |
| `TEST_DATABASE_URL must be set to run integration tests`     | Add `TEST_DATABASE_URL` to `.env` (see `.env.example`).                                                                                                     |
| `database "payguard_test" does not exist`                    | The init script runs only on a fresh volume. Run `docker compose exec postgres createdb -U payguard payguard_test`, or reset with `docker compose down -v`. |
| `ExperimentalWarning: VM Modules is an experimental feature` | Expected: Jest's ESM mode prints this. It is harmless.                                                                                                      |
| Prisma suggests updating to `8.0.0-rc.*`                     | Ignore it. Prisma publishes release candidates under its `latest` tag, and this project pins the stable 7.10.1.                                             |
| Prettier reports every file as changed on Windows            | Line endings: `.gitattributes` enforces LF. Re-checkout, or set `git config core.autocrlf false`.                                                           |
