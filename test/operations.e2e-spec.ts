import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import { OutboxStore } from '../src/outbox/outbox-store.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { PaymentsController } from '../src/payments/payments.controller.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { WorkerModule } from '../src/worker.module.js';
import { runCli, TEST_OPERATOR } from './support/admin-cli.js';
import { drainOutbox, expireLeases, jobsOf } from './support/outbox.js';
import { paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';

describe('Operations (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let api: ReturnType<typeof paymentsApi>;
  let worker: OutboxWorker;
  let acme: Merchant;

  beforeAll(async () => {
    app = await createTestApp({ provider });
    prisma = prismaOf(app);
    api = paymentsApi(app);
    worker = app.get(OutboxWorker);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    provider.reset();
    acme = await provisionMerchant(app, 'acme');
  });

  afterAll(async () => {
    await app.close();
  });

  const createPayment = async (key = 'key-1') =>
    (await api.create(acme, key).expect(202)).body as PaymentResponse;

  describe('poison jobs', () => {
    it('parks a job that keeps crashing its workers instead of reclaiming it forever', async () => {
      const payment = await createPayment();
      const store = app.get(OutboxStore);
      for (let crash = 0; crash < 10; crash++) {
        await store.claim('crashing-worker', 10);
        await expireLeases(prisma);
      }

      await expect(worker.processDueJobs()).resolves.toBe(1);

      await expect(jobsOf(prisma)).resolves.toEqual([
        expect.objectContaining({
          status: 'DEAD',
          runCount: 11,
          lastError: 'LEASE_EXPIRED',
        }),
      ]);
      const [job] = await prisma.outboxJob.findMany();
      expect(job.leaseRecoveries).toBe(10);
      expect(provider.submissions).toHaveLength(0);
      await expect(worker.processDueJobs()).resolves.toBe(0);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
    });
  });

  describe('operator audit trail', () => {
    const events = () =>
      prisma.operatorAuditEvent.findMany({ orderBy: { createdAt: 'asc' } });

    it('records each state-changing command once, with its actor and no secrets', async () => {
      await resetDatabase(prisma);
      const created = await runCli(
        app,
        'merchant:create',
        '--name',
        'Globex',
        '--slug',
        'globex',
      );
      const key = /pgsk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/.exec(created.out)![0];
      const issued = await runCli(
        app,
        'key:create',
        '--merchant',
        'globex',
        '--label',
        'rotation',
      );
      const secondKey = /pgsk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/.exec(
        issued.out,
      )![0];
      for (let i = 0; i < 2; i++) {
        await runCli(app, 'merchant:suspend', '--merchant', 'globex');
        await runCli(app, 'key:revoke', '--key', key.slice(0, 21));
      }
      await runCli(app, 'merchant:reactivate', '--merchant', 'globex');
      const duplicate = await runCli(
        app,
        'merchant:create',
        '--name',
        'Globex',
        '--slug',
        'globex',
      );
      expect(duplicate.code).toBe(1);

      const recorded = await events();
      expect(recorded.map((event) => event.action)).toEqual([
        'merchant.created',
        'api_key.issued',
        'merchant.suspended',
        'api_key.revoked',
        'merchant.reactivated',
      ]);
      expect(new Set(recorded.map((event) => event.actor))).toEqual(
        new Set([TEST_OPERATOR]),
      );
      const serialized = JSON.stringify(recorded);
      expect(
        serialized.includes(key.slice(22)) ||
          serialized.includes(secondKey.slice(22)),
      ).toBe(false);
      expect(recorded[1]).toMatchObject({
        targetType: 'api_key',
        details: { prefix: secondKey.slice(0, 21), label: 'rotation' },
      });

      const listed = await runCli(app, 'audit:list', '--limit', '2');
      expect(listed.out.split('\n')).toHaveLength(2);
      expect(listed.out).toContain('merchant.reactivated');
    });

    it('keeps audit records append-only for the application', async () => {
      await runCli(app, 'merchant:suspend', '--merchant', 'acme');
      const recorded = (await events()).length;

      await expect(
        prisma.operatorAuditEvent.updateMany({
          data: { actor: 'someone-else' },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.operatorAuditEvent.deleteMany()).rejects.toThrow(
        /append-only/,
      );
      await expect(events()).resolves.toHaveLength(recorded);
    });

    it('audits a manual requeue', async () => {
      await createPayment();
      await prisma.$executeRaw`UPDATE outbox_jobs SET status = 'DEAD', run_count = 10`;
      const [job] = await prisma.outboxJob.findMany();

      await expect(
        runCli(app, 'outbox:requeue', '--job', job.id),
      ).resolves.toMatchObject({ code: 0 });

      await expect(
        prisma.operatorAuditEvent.findMany({
          where: { action: 'outbox_job.requeued' },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          actor: TEST_OPERATOR,
          targetId: job.id,
          details: expect.objectContaining({ previousRunCount: 10 }),
        }),
      ]);
    });
  });

  describe('API key usage tracking', () => {
    it('records first use and stays quiet within the tracking window', async () => {
      const keyRow = () =>
        prisma.merchantApiKey.findUniqueOrThrow({
          where: { id: acme.apiKeyId },
        });
      await expect(keyRow()).resolves.toMatchObject({ lastUsedAt: null });

      await request(app.getHttpServer())
        .get('/v1/merchants/me')
        .set('Authorization', `Bearer ${acme.apiKey}`)
        .expect(200);
      const first = (await keyRow()).lastUsedAt;
      expect(first).toBeInstanceOf(Date);

      await request(app.getHttpServer())
        .get('/v1/merchants/me')
        .set('Authorization', `Bearer ${acme.apiKey}`)
        .expect(200);
      expect((await keyRow()).lastUsedAt).toEqual(first);

      const listed = await runCli(app, 'key:list', '--merchant', 'acme');
      expect(listed.out).toContain(`lastUsed=${first!.toISOString()}`);
      const keys = await request(app.getHttpServer())
        .get('/v1/api-keys')
        .set('Authorization', `Bearer ${acme.apiKey}`)
        .expect(200);
      expect((keys.body as { lastUsedAt: string }[])[0].lastUsedAt).toBe(
        first!.toISOString(),
      );
    });
  });

  describe('retention', () => {
    const age = (days: number) =>
      prisma.$executeRaw`
        UPDATE outbox_jobs SET completed_at = now() - ${days} * interval '1 day'
        WHERE status = 'COMPLETED'`;

    it('prunes only old completed jobs of settled attempts, in bounded batches', async () => {
      for (let i = 0; i < 3; i++) await createPayment(`settled-${i}`);
      await drainOutbox(app, prisma);
      await age(40);
      await createPayment('recent');
      await drainOutbox(app, prisma);
      provider.willThrow(new Error('connection reset'));
      const unresolved = await createPayment('unresolved');
      await worker.processDueJobs();
      await prisma.$executeRaw`
        UPDATE outbox_jobs SET completed_at = now() - interval '40 days'
        WHERE attempt_id = ${unresolved.attempts[0].id}::uuid AND status = 'COMPLETED'`;
      const before = await prisma.outboxJob.count();

      const pruned = await runCli(
        app,
        'maintenance:prune',
        '--completed-jobs-days',
        '30',
        '--batch-size',
        '1',
      );

      expect(pruned).toMatchObject({ code: 0 });
      expect(pruned.out).toContain('Deleted 3 completed outbox jobs');
      await expect(prisma.outboxJob.count()).resolves.toBe(before - 3);
      const remaining = await prisma.outboxJob.findMany({
        select: { attemptId: true, status: true },
      });
      expect(
        remaining.filter((job) => job.attemptId === unresolved.attempts[0].id),
      ).toHaveLength(2);
      await expect(prisma.payment.count()).resolves.toBe(5);
      await expect(prisma.paymentAttempt.count()).resolves.toBe(5);

      const again = await runCli(
        app,
        'maintenance:prune',
        '--completed-jobs-days',
        '30',
      );
      expect(again.out).toContain('Deleted 0 completed outbox jobs');
      await expect(
        prisma.operatorAuditEvent.count({
          where: { action: 'maintenance.pruned' },
        }),
      ).resolves.toBe(2);
    });

    it.each([
      [['--completed-jobs-days', '1'], 'from 7'],
      [[], 'Missing required option --completed-jobs-days'],
      [['--completed-jobs-days', '30', '--batch-size', '0'], '--batch-size'],
    ])('refuses unsafe prune arguments %j', async (args, message) => {
      const result = await runCli(app, 'maintenance:prune', ...args);

      expect(result.code).toBe(1);
      expect(result.err).toContain(message);
    });
  });

  describe('worker health and metrics', () => {
    const readiness = async () =>
      (await request(app.getHttpServer()).get('/health').expect(200)).body as {
        status: string;
        details: { workers: unknown };
      };

    it('reports no active worker until one sends a heartbeat, and again once it goes silent', async () => {
      await expect(readiness()).resolves.toMatchObject({
        status: 'degraded',
        details: {
          workers: { status: 'degraded', reasons: ['no_active_worker'] },
        },
      });

      await worker.recordHeartbeat();
      await expect(readiness()).resolves.toMatchObject({
        status: 'ok',
        details: { workers: { status: 'up' } },
      });

      await prisma.$executeRaw`UPDATE outbox_workers SET heartbeat_at = now() - interval '5 minutes'`;
      await expect(readiness()).resolves.toMatchObject({
        details: {
          workers: { status: 'degraded', reasons: ['no_active_worker'] },
        },
      });
    });

    it('shows workers in ops:status and exports bounded metrics', async () => {
      await createPayment();
      await drainOutbox(app, prisma);
      await worker.recordHeartbeat();

      const status = await runCli(app, 'ops:status');
      expect(status.out).toContain(`${worker.workerId}  active`);
      expect(status.out).toMatch(/jobs=[1-9]\d*/);

      const metrics = await runCli(app, 'ops:metrics');
      expect(metrics.code).toBe(0);
      expect(metrics.out).toContain('payguard_workers_active 1');
      expect(metrics.out).toContain(
        'payguard_payment_attempts{status="SUCCEEDED",failure_code="none"} 1',
      );
      expect(metrics.out).not.toContain(acme.merchantId);
      expect(metrics.out).not.toContain(worker.workerId);
    });
  });

  describe('graceful shutdown', () => {
    it('finishes the job in flight and records its outcome before the process stops', async () => {
      const shutdownProvider = new ScriptedProvider();
      const instance = await createTestApp({ provider: shutdownProvider });
      const created = (
        await paymentsApi(instance).create(acme, 'shutdown').expect(202)
      ).body as PaymentResponse;
      const held = shutdownProvider.hold();
      const instanceWorker = instance.get(OutboxWorker);
      instanceWorker.start();
      await held.entered;

      let closed = false;
      const closing = instance.close().then(() => (closed = true));
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      await expect(jobsOf(prisma)).resolves.toEqual([
        expect.objectContaining({ status: 'PROCESSING' }),
      ]);

      held.release();
      await closing;

      await expect(api.read(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      await expect(jobsOf(prisma)).resolves.toEqual([
        expect.objectContaining({ status: 'COMPLETED' }),
      ]);
      const [row] = await prisma.outboxWorker.findMany();
      expect(row.stoppedAt).toBeInstanceOf(Date);
    });
  });

  describe('standalone worker', () => {
    it('processes the shared queue without any HTTP components', async () => {
      const created = await createPayment();
      const standalone = await NestFactory.createApplicationContext(
        WorkerModule,
        {
          logger: false,
        },
      );
      try {
        expect(() =>
          standalone.get(PaymentsController, { strict: false }),
        ).toThrow();
        await expect(
          standalone.get(OutboxWorker).processDueJobs(),
        ).resolves.toBe(1);
      } finally {
        await standalone.close();
      }

      await expect(api.read(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
    });
  });
});
