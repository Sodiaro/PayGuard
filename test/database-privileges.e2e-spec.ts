import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { readdirSync } from 'node:fs';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/database/prisma.service.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import { runCli } from './support/admin-cli.js';
import { makeJobsDue } from './support/outbox.js';
import { paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  operatorOf,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { ownerDatabase, resetDatabase } from './support/test-database.js';
import { eventFor, webhooksApi } from './support/webhooks.js';

type Database = PrismaService | PrismaClient;

// The roles provisioned by docker/postgres/init/01-roles-and-databases.sh and granted to by the
// migrations. The application (API and worker) runs as payguard_app, the CLI as payguard_cli.
describe('Database roles and privileges (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  let runtime: PrismaService;
  let operator: PrismaService;
  let owner: PrismaClient;
  let acme: Merchant;

  beforeAll(async () => {
    app = await createTestApp({ provider });
    runtime = prismaOf(app);
    operator = operatorOf(app).get(PrismaService);
    owner = ownerDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    provider.reset();
    acme = await provisionMerchant(app, 'acme');
  });

  afterAll(async () => {
    await app.close();
  });

  const whoAmI = async (db: Database) =>
    (await db.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`)[0]
      .user;

  const denied = (db: Database, statement: string) =>
    expect(db.$executeRawUnsafe(statement)).rejects.toThrow(
      /permission denied|must be owner|must be superuser/,
    );

  it('connects the application, the CLI and migrations as three different roles', async () => {
    await expect(whoAmI(runtime)).resolves.toBe('payguard_app');
    await expect(whoAmI(operator)).resolves.toBe('payguard_cli');
    await expect(whoAmI(owner)).resolves.toBe('payguard_owner');

    const [membership] = await runtime.$queryRaw<
      { runtime: boolean; operator: boolean }[]
    >`
      SELECT pg_has_role('payguard_app', 'payguard_runtime', 'MEMBER') AS runtime,
             pg_has_role('payguard_app', 'payguard_operator', 'MEMBER') AS operator`;
    expect(membership).toEqual({ runtime: true, operator: false });
  });

  it('gives none of the roles superuser, role or database creation, replication or row-security bypass', async () => {
    const roles = await owner.$queryRaw<Record<string, unknown>[]>`
      SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname LIKE 'payguard\_%' ORDER BY rolname`;

    expect(roles.map((role) => role.rolname)).toEqual(
      expect.arrayContaining([
        'payguard_app',
        'payguard_cli',
        'payguard_operator',
        'payguard_owner',
        'payguard_runtime',
      ]),
    );
    for (const role of roles) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      });
    }
  });

  describe.each([
    ['the runtime role', () => runtime],
    ['the operator role', () => operator],
  ])('history is append-only for %s by privilege', (_role, db) => {
    // Rows in both history tables: a payment's creation, then an audited operator action.
    beforeEach(async () => {
      await paymentsApi(app).create(acme, 'key-1').expect(202);
      await runCli(app, 'merchant:suspend', '--merchant', 'acme');
    });

    it.each([
      "UPDATE payment_events SET type = 'payment.forged'",
      'DELETE FROM payment_events',
      'TRUNCATE payment_events',
      "UPDATE operator_audit_events SET actor = 'someone-else'",
      'DELETE FROM operator_audit_events',
      'TRUNCATE operator_audit_events',
    ])('refuses %s', async (statement) => {
      await denied(db(), statement);
    });

    it('cannot remove the append-only triggers or bypass them', async () => {
      await denied(
        db(),
        'ALTER TABLE payment_events DISABLE TRIGGER payment_events_append_only',
      );
      await denied(
        db(),
        'DROP TRIGGER operator_audit_events_append_only ON operator_audit_events',
      );
      await denied(db(), 'SET session_replication_role = replica');
    });
  });

  it('stops even the owner at the append-only trigger', async () => {
    await paymentsApi(app).create(acme, 'key-1').expect(202);

    await expect(
      owner.$executeRawUnsafe(
        "UPDATE payment_events SET type = 'payment.forged'",
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.$executeRawUnsafe('DELETE FROM operator_audit_events'),
    ).rejects.toThrow(/append-only/);
  });

  it.each([
    'CREATE ROLE intruder',
    'CREATE DATABASE intruder',
    'ALTER ROLE payguard_app SUPERUSER',
    'ALTER ROLE payguard_app CREATEROLE',
    'GRANT payguard_operator TO payguard_app',
    'CREATE TABLE intruder (id int)',
    'ALTER TABLE payments ADD COLUMN intruder int',
    'TRUNCATE outbox_jobs',
    'DELETE FROM outbox_jobs',
    'DELETE FROM payments',
    'UPDATE payments SET amount = 1',
    'UPDATE payment_attempts SET payment_id = gen_random_uuid()',
    "UPDATE merchants SET status = 'SUSPENDED'",
    "INSERT INTO operator_audit_events (id, actor, action, target_type, target_id) VALUES (gen_random_uuid(), 'x', 'x.x', 'x', 'x')",
  ])('refuses the runtime role: %s', async (statement) => {
    await denied(runtime, statement);
  });

  it.each([
    "UPDATE payments SET status = 'SUCCEEDED'",
    "UPDATE payment_attempts SET status = 'SUCCEEDED'",
    'DELETE FROM payments',
    'DELETE FROM merchants',
    "INSERT INTO payments (id, merchant_id, amount, currency, idempotency_key, request_fingerprint, updated_at) VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'NGN', 'k', repeat('0', 64), now())",
    'CREATE TABLE intruder (id int)',
    'CREATE ROLE intruder',
  ])('refuses the operator role: %s', async (statement) => {
    await denied(operator, statement);
  });

  it('grants exactly the privileges the migrations document', async () => {
    const grants = async (role: string) => {
      const rows = await owner.$queryRaw<{ grant: string }[]>`
        SELECT c.relname || ': ' || acl.privilege_type AS "grant"
        FROM pg_class c, aclexplode(c.relacl) acl
        WHERE c.relnamespace = 'public'::regnamespace AND acl.grantee = ${role}::regrole
        UNION ALL
        SELECT c.relname || ': ' || acl.privilege_type || ' (' || a.attname || ')'
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, aclexplode(a.attacl) acl
        WHERE c.relnamespace = 'public'::regnamespace AND acl.grantee = ${role}::regrole
        ORDER BY 1`;
      return rows.map((row) => row.grant);
    };

    expect(await grants('payguard_runtime')).toEqual([
      'merchant_api_keys: SELECT',
      'merchant_api_keys: UPDATE (last_used_at)',
      'merchants: SELECT',
      'outbox_jobs: INSERT',
      'outbox_jobs: SELECT',
      'outbox_jobs: UPDATE (available_at)',
      'outbox_jobs: UPDATE (completed_at)',
      'outbox_jobs: UPDATE (last_error)',
      'outbox_jobs: UPDATE (lease_recoveries)',
      'outbox_jobs: UPDATE (lease_token)',
      'outbox_jobs: UPDATE (locked_by)',
      'outbox_jobs: UPDATE (locked_until)',
      'outbox_jobs: UPDATE (run_count)',
      'outbox_jobs: UPDATE (status)',
      'outbox_jobs: UPDATE (updated_at)',
      'outbox_workers: INSERT',
      'outbox_workers: SELECT',
      'outbox_workers: UPDATE (heartbeat_at)',
      'outbox_workers: UPDATE (jobs_finished)',
      'outbox_workers: UPDATE (last_job_finished_at)',
      'outbox_workers: UPDATE (stopped_at)',
      'payment_attempts: INSERT',
      'payment_attempts: SELECT',
      'payment_attempts: UPDATE (completed_at)',
      'payment_attempts: UPDATE (failure_code)',
      'payment_attempts: UPDATE (provider_reference)',
      'payment_attempts: UPDATE (status)',
      'payment_attempts: UPDATE (submitted_at)',
      'payment_events: INSERT',
      'payment_events: SELECT',
      'payment_retry_requests: INSERT',
      'payment_retry_requests: SELECT',
      'payments: INSERT',
      'payments: SELECT',
      'payments: UPDATE (status)',
      'payments: UPDATE (updated_at)',
      'provider_webhook_events: INSERT',
      'provider_webhook_events: SELECT',
      'provider_webhook_events: UPDATE (conflicting_deliveries)',
      'provider_webhook_events: UPDATE (duplicate_deliveries)',
      'provider_webhook_events: UPDATE (last_conflict_at)',
      'provider_webhook_events: UPDATE (processed_at)',
      'provider_webhook_events: UPDATE (result)',
      'provider_webhook_events: UPDATE (status)',
    ]);
    expect(await grants('payguard_operator')).toEqual([
      'merchant_api_keys: INSERT',
      'merchant_api_keys: SELECT',
      'merchant_api_keys: UPDATE (revoked_at)',
      'merchants: INSERT',
      'merchants: SELECT',
      'merchants: UPDATE (status)',
      'merchants: UPDATE (updated_at)',
      'operator_audit_events: INSERT',
      'operator_audit_events: SELECT',
      'outbox_jobs: DELETE',
      'outbox_jobs: SELECT',
      'outbox_jobs: UPDATE (available_at)',
      'outbox_jobs: UPDATE (run_count)',
      'outbox_jobs: UPDATE (status)',
      'outbox_jobs: UPDATE (updated_at)',
      'outbox_workers: DELETE',
      'outbox_workers: SELECT',
      'payment_attempts: SELECT',
      'payment_events: INSERT',
      'payment_events: SELECT',
      'payment_retry_requests: SELECT',
      'payments: SELECT',
      'provider_webhook_events: SELECT',
    ]);
    // Login roles hold nothing directly; they act only through their group.
    expect(await grants('payguard_app')).toEqual([]);
    expect(await grants('payguard_cli')).toEqual([]);
  });

  it('applies every migration as the owner, who owns every application object', async () => {
    const migrations = readdirSync('prisma/migrations', {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory()).length;
    const [applied] = await owner.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(applied.count).toBe(migrations);

    const foreign = await owner.$queryRaw<{ object: string }[]>`
      SELECT relname AS object FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'i', 'S')
        AND relowner <> 'payguard_owner'::regrole
      UNION ALL
      SELECT proname FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proowner <> 'payguard_owner'::regrole`;
    expect(foreign).toEqual([]);
  });

  it('runs creation, processing, a webhook, a retry and reconciliation entirely as the runtime role', async () => {
    const api = paymentsApi(app);
    const webhooks = webhooksApi(app);
    const worker = app.get(OutboxWorker);

    provider.willReturn(SimulatorOutcome.Declined);
    const declined = (await api.create(acme, 'declined').expect(202))
      .body as PaymentResponse;
    await worker.processDueJobs();
    await api.retry(acme, declined.id, 'retry-1').expect(202);
    provider.willProcessThenTimeOut(SimulatorOutcome.Succeeded);
    await worker.processDueJobs();
    const retried = await api.read(acme, declined.id);
    await webhooks.deliver(eventFor(retried, 'payment.succeeded')).expect(202);
    await worker.processDueJobs();

    const reconciled = (await api.create(acme, 'reconciled').expect(202))
      .body as PaymentResponse;
    await worker.processDueJobs();
    await makeJobsDue(runtime);
    await worker.processDueJobs();
    await worker.recordHeartbeat();

    await expect(api.read(acme, declined.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      attempts: [{ status: 'FAILED' }, { status: 'SUCCEEDED' }],
    });
    await expect(api.read(acme, reconciled.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
    await expect(
      runtime.paymentEvent.count({ where: { type: 'attempt.resolved' } }),
    ).resolves.toBe(3);
  });

  it('lets the CLI do its work with the operator role alone', async () => {
    const created = await runCli(
      app,
      'merchant:create',
      '--name',
      'Globex',
      '--slug',
      'globex',
    );
    expect(created.code).toBe(0);
    for (const command of [
      ['key:list', '--merchant', 'globex'],
      ['merchant:suspend', '--merchant', 'globex'],
      ['ops:status'],
      ['ops:metrics'],
      ['audit:list'],
      ['payments:unresolved'],
      ['maintenance:prune', '--completed-jobs-days', '30'],
    ]) {
      await expect(runCli(app, ...command)).resolves.toMatchObject({ code: 0 });
    }
  });
});
