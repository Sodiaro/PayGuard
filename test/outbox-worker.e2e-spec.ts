import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { runAdminCli } from '../src/cli/admin-cli.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import { OperatorAuditLog } from '../src/audit/operator-audit-log.js';
import { ApiKeysService } from '../src/merchants/api-keys.service.js';
import { MerchantsService } from '../src/merchants/merchants.service.js';
import { OutboxStore } from '../src/outbox/outbox-store.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { failWritesTo } from './support/db-faults.js';
import {
  drainOutbox,
  expireLeases,
  jobsOf,
  makeJobsDue,
} from './support/outbox.js';
import { paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';

describe('Outbox and worker (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let api: ReturnType<typeof paymentsApi>;
  let worker: OutboxWorker;
  let store: OutboxStore;
  let acme: Merchant;

  beforeAll(async () => {
    app = await createTestApp({ provider });
    prisma = prismaOf(app);
    api = paymentsApi(app);
    worker = app.get(OutboxWorker);
    store = app.get(OutboxStore);
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

  it('commits payment, attempt and job together or not at all', async () => {
    const restore = await failWritesTo(prisma, 'outbox_jobs', 'INSERT');
    try {
      const response = await api.create(acme, 'key-1').expect(500);
      expect(response.body).toMatchObject({
        message: 'An unexpected error occurred',
      });
    } finally {
      await restore();
    }

    await expect(prisma.payment.count()).resolves.toBe(0);
    await expect(prisma.paymentAttempt.count()).resolves.toBe(0);
    await expect(prisma.outboxJob.count()).resolves.toBe(0);

    await api.create(acme, 'key-1').expect(202);
  });

  it('never lets two workers hold a lease on the same job', async () => {
    await createPayment();

    const [first, second] = await Promise.all([
      store.claim('worker-a', 10),
      store.claim('worker-b', 10),
    ]);

    expect(first.length + second.length).toBe(1);
  });

  it('skips a job another transaction has locked instead of waiting for it', async () => {
    await createPayment();

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outbox_jobs FOR UPDATE`;
      const claims = await Promise.all([
        store.claim('worker-a', 10),
        store.claim('worker-b', 10),
      ]);
      expect(claims.flat()).toHaveLength(0);
    });

    await expect(store.claim('worker-c', 10)).resolves.toHaveLength(1);
  });

  it('fences a worker out once its lease has been taken over', async () => {
    await createPayment();
    const [stale] = await store.claim('worker-a', 10);
    await expireLeases(prisma);
    const [current] = await store.claim('worker-b', 10);

    await expect(store.complete(prisma, stale)).resolves.toBe(false);
    await expect(
      store.reschedule(prisma, stale, 'INTERNAL_ERROR'),
    ).resolves.toBe('lease_lost');
    await expect(jobsOf(prisma)).resolves.toEqual([
      expect.objectContaining({ status: 'PROCESSING', runCount: 2 }),
    ]);

    await expect(store.complete(prisma, current)).resolves.toBe(true);
  });

  it('processes each payment exactly once when workers compete', async () => {
    for (let i = 0; i < 6; i++) await createPayment(`key-${i}`);

    await Promise.all([
      worker.processDueJobs(),
      worker.processDueJobs(),
      worker.processDueJobs(),
    ]);
    await drainOutbox(app, prisma);

    const attemptIds = provider.submissions.map((call) => call.attemptId);
    expect(attemptIds).toHaveLength(6);
    expect(new Set(attemptIds).size).toBe(6);
    await expect(
      prisma.payment.count({ where: { status: 'SUCCEEDED' } }),
    ).resolves.toBe(6);
  });

  it('recovers a job whose worker died after claiming it, before submitting', async () => {
    const payment = await createPayment();
    const [abandoned] = await store.claim('crashed-worker', 10);
    expect(abandoned.attemptId).toBe(payment.attempts[0].id);

    await expect(worker.processDueJobs()).resolves.toBe(0);
    await expireLeases(prisma);
    await expect(worker.processDueJobs()).resolves.toBe(1);

    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
    expect(provider.submissions).toHaveLength(1);
    await expect(jobsOf(prisma)).resolves.toEqual([
      expect.objectContaining({
        status: 'COMPLETED',
        runCount: 2,
        lastError: 'LEASE_EXPIRED',
      }),
    ]);
  });

  it('ignores a duplicate delivery of finished work', async () => {
    const payment = await createPayment();
    await drainOutbox(app, prisma);

    await prisma.$executeRaw`
      UPDATE outbox_jobs SET status = 'QUEUED', completed_at = NULL, available_at = now()`;
    await expect(worker.processDueJobs()).resolves.toBe(1);

    expect(provider.submissions).toHaveLength(1);
    await expect(prisma.paymentAttempt.count()).resolves.toBe(1);
    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
    await expect(jobsOf(prisma)).resolves.toEqual([
      expect.objectContaining({ status: 'COMPLETED' }),
    ]);
  });

  it('retries internal failures with backoff and recovers once they clear', async () => {
    const payment = await createPayment();
    const restore = await failWritesTo(prisma, 'payment_attempts', 'UPDATE');
    try {
      await worker.processDueJobs();
    } finally {
      await restore();
    }

    const [job] = await prisma.outboxJob.findMany();
    expect(job).toMatchObject({
      status: 'QUEUED',
      runCount: 1,
      lastError: 'INTERNAL_ERROR',
    });
    expect(job.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(provider.submissions).toHaveLength(0);

    await drainOutbox(app, prisma);
    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
  });

  it('parks a job as DEAD after its run limit, visible to health checks and operators', async () => {
    const payment = await createPayment();
    const restore = await failWritesTo(prisma, 'payment_attempts', 'UPDATE');
    try {
      for (let run = 0; run < 10; run++) {
        await makeJobsDue(prisma);
        await worker.processDueJobs();
      }
    } finally {
      await restore();
    }

    const [job] = await prisma.outboxJob.findMany();
    expect(job).toMatchObject({
      status: 'DEAD',
      runCount: 10,
      lastError: 'INTERNAL_ERROR',
    });
    await expect(worker.processDueJobs()).resolves.toBe(0);
    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'PENDING',
    });

    await worker.recordHeartbeat();
    const health = await request(app.getHttpServer())
      .get('/health')
      .expect(200);
    expect(health.body).toMatchObject({
      status: 'degraded',
      details: {
        queue: { status: 'degraded', reasons: ['dead_jobs'] },
        workers: { status: 'up' },
      },
    });

    const out: string[] = [];
    const run = (...argv: string[]) =>
      runAdminCli(
        argv,
        {
          merchants: app.get(MerchantsService),
          apiKeys: app.get(ApiKeysService),
          outbox: store,
          audit: new OperatorAuditLog(prismaOf(app)),
          actor: 'test-operator',
        },
        { out: (line) => out.push(line), err: (line) => out.push(line) },
      );

    await expect(run('ops:status')).resolves.toBe(0);
    expect(out.join('\n')).toMatch(/Dead jobs:\s+1/);
    expect(out.join('\n')).toContain(job.id);
    expect(out.join('\n')).toMatch(/Unresolved attempts:\s+1/);

    await expect(run('outbox:requeue', '--job', job.id)).resolves.toBe(0);
    await drainOutbox(app, prisma);
    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
  });

  it('reports a healthy queue and worker when nothing is stuck', async () => {
    await worker.recordHeartbeat();
    const health = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(health.body).toMatchObject({
      status: 'ok',
      details: {
        database: { status: 'up' },
        queue: { status: 'up' },
        workers: { status: 'up' },
      },
    });
  });
});
