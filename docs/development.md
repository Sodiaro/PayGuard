# Development

Detailed local setup, the Docker Compose stack, and the project's commands. The short path is in
the [README](../README.md#getting-started).

- [Prerequisites](#prerequisites)
- [Local setup](#local-setup)
- [Docker Compose stack](#docker-compose-stack)
- [Commands](#commands)
- [Platform notes](#platform-notes)

## Prerequisites

| Tool                              | Version                                   |
| --------------------------------- | ----------------------------------------- |
| Node.js                           | 24 LTS (see `.nvmrc`)                     |
| npm                               | 11 (bundled with Node 24)                 |
| Docker with the Compose v2 plugin | Any recent release (Docker Desktop works) |

## Local setup

```bash
# 1. Configure the environment, then edit .env and replace every "change-me". Each role's password
#    must match in PAYGUARD_*_PASSWORD and in the URLs that use that role.
cp .env.example .env

# 2. Install dependencies from the lockfile (this also generates the Prisma client).
npm ci

# 3. Start PostgreSQL. On first start of the volume it provisions the database roles and creates
#    the payguard and payguard_test databases.
docker compose up -d postgres

# 4. Apply database migrations (as the schema owner, MIGRATION_DATABASE_URL).
npm run db:migrate:deploy

# 5. Provision a merchant; the API key is printed once.
npm run admin -- merchant:create --name "Acme Ltd"

# 6. Run the API in watch mode. It also runs the payment worker unless OUTBOX_WORKER_ENABLED=false.
npm run start:dev
```

To run the worker as its own process instead, set `OUTBOX_WORKER_ENABLED=false` and run
`npm run build && npm run start:worker` in a second terminal.

With an existing PostgreSQL server or a data volume created before the database roles existed,
run the provisioning script by hand instead of relying on step 3 (see
[operations.md](operations.md#database-roles)).

- `GET /health` and `GET /health/live`: readiness and liveness (no authentication)
- `/docs`: Swagger UI when `SWAGGER_ENABLED=true`; use **Authorize** to send a key

## Docker Compose stack

```bash
docker compose up --build
docker compose run --rm cli merchant:create --name "Acme Ltd"
```

This starts PostgreSQL (provisioning the roles on a new volume) and runs a one-off `migrate` job
(`prisma migrate deploy`, as the schema owner). It then starts two services from the same
production image: `api` (HTTP only, `OUTBOX_WORKER_ENABLED=false`) on `127.0.0.1:${API_HOST_PORT}`,
and `worker` (`node dist/worker.js`, no HTTP port), both connecting as the runtime role. The `cli`
service (profile `tools`, started only by `docker compose run`) runs the operator CLI with the
operator role's credentials, which the `api` and `worker` containers never hold. All three run as
the unprivileged `node` user with a read-only root filesystem (only `/tmp` is writable), all Linux
capabilities dropped and `no-new-privileges`; the long-running ones have a 30 s stop grace period.
Stop the stack with `docker compose down`; add `-v` to delete the database volume as well.

**This stack runs with `NODE_ENV=development`.** Its only payment provider is the simulator, which
production refuses (see [configuration.md](configuration.md#development-test-and-production)). It
is a local, production-like demonstration with hardened containers and simulated payments, not a
deployment. The same image started with `NODE_ENV=production` exits at startup.

To deliver a simulator webhook inside the stack, address the API by its service name:
`docker compose run --rm cli simulator:webhook --attempt <id> --url http://api:3000`.

## Commands

| Command                     | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `npm run start:dev`         | Start the API with file watching                                             |
| `npm run build`             | Compile to `dist/`                                                           |
| `npm run start:prod`        | Run the compiled app (`node dist/main.js`)                                   |
| `npm run start:worker`      | Run the compiled standalone worker (`node dist/worker.js`)                   |
| `npm run admin -- <cmd>`    | Build, then run the operator CLI (see [operations.md](operations.md))        |
| `npm test`                  | Unit tests (no database needed)                                              |
| `npm run test:cov`          | Unit tests with a coverage report in `coverage/`                             |
| `npm run test:e2e`          | Integration and HTTP tests against PostgreSQL (`TEST_*DATABASE_URL`)         |
| `npm run test:soak`         | Opt-in concurrency soak with worker processes (see [testing.md](testing.md)) |
| `npm run smoke:docker`      | Build and smoke-test the Compose stack in an isolated project                |
| `npm run lint`              | ESLint with type-aware rules (`lint:fix` to auto-fix)                        |
| `npm run format:check`      | Check Prettier formatting (`format` to rewrite files)                        |
| `npm run typecheck`         | Type-check sources and tests without emitting output                         |
| `npm run prisma:generate`   | Regenerate the Prisma client after editing the schema                        |
| `npm run prisma:validate`   | Validate `prisma/schema.prisma`                                              |
| `npm run db:migrate:dev`    | Create and apply a migration in development (see the note below)             |
| `npm run db:migrate:deploy` | Apply pending migrations (CI, Docker, production)                            |
| `npm run db:migrate:check`  | Fail if the migrated database and `schema.prisma` differ (CI)                |

`db:migrate:dev` needs a shadow database, which Prisma creates and drops itself. The schema owner
role (`payguard_owner`) is deliberately not allowed to create databases, so the command currently
fails with `P3014` when run with the `MIGRATION_DATABASE_URL` from `.env.example`.

## Platform notes

- **NestJS 12 uses native ES modules** (`"type": "module"`). Relative imports need the `.js`
  suffix (`import { X } from './x.js'`), even in TypeScript files.
- **Jest runs in ESM mode** (`--experimental-vm-modules`, ts-jest ESM preset). Test files import
  `describe`, `it`, `expect` and `jest` from `@jest/globals`.
- **Prisma 7** keeps its CLI configuration in `prisma.config.ts`, generates the client into
  `src/generated/prisma` (not committed), and connects through the `@prisma/adapter-pg` driver
  adapter. `migrate dev` no longer regenerates the client; run `npm run prisma:generate` after
  schema changes.
