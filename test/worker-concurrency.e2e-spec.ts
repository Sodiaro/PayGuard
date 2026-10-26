import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types.js';

// Lookups become due one second after a lost answer, while the workers are running.
process.env.RECONCILIATION_DELAY_SECONDS = '1';
process.env.OUTBOX_POLL_INTERVAL_MS = '100';
const { OutboxWorker } =
  await import('../src/payments/processing/outbox-worker.js');
const { PAYMENT_PROVIDER } =
  await import('../src/payments/providers/payment-provider.js');
const { SimulatorOutcome } =
  await import('../src/payments/providers/simulated-payment-provider.js');
const { WorkerModule } = await import('../src/worker.module.js');
const { outboxDiagnostics } = await import('./support/outbox.js');
const { paymentsApi } = await import('./support/payments-api.js');
const { ScriptedProvider } = await import('./support/scripted-provider.js');
const { createTestApp, prismaOf, provisionMerchant } =
  await import('./support/test-app.js');
const { resetDatabase } = await import('./support/test-database.js');
const { waitFor } = await import('./support/wait.js');

const PAYMENTS = 12;

describe('Independent workers running concurrently (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  const workers: TestingModule[] = [];

  beforeAll(async () => {
    app = await createTestApp({ provider });
    await resetDatabase();
    // Separate application contexts: each worker has its own connection pool and worker ID,
    // as standalone worker processes would.
    for (let i = 0; i < 2; i++) {
      const context = await Test.createTestingModule({
        imports: [WorkerModule],
      })
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(provider)
        .compile();
      await context.init();
      workers.push(context);
    }
  });

  afterAll(async () => {
    await Promise.all(workers.map((context) => context.close()));
    await app.close();
  });

  it('settles every payment exactly once while work arrives and becomes due during processing', async () => {
    const prisma = prismaOf(app);
    const api = paymentsApi(app);
    const merchant = await provisionMerchant(app, 'acme');
    provider.willProcessThenTimeOut(SimulatorOutcome.Succeeded);
    for (const context of workers) context.get(OutboxWorker).start();

    // Every fourth key is sent twice at once: duplicates must not create work.
    const keys = Array.from({ length: PAYMENTS }, (_, i) => `key-${i}`);
    const requests = [...keys, ...keys.filter((_, i) => i % 4 === 0)];
    const statuses = await Promise.all(
      requests.map(async (key) => (await api.create(merchant, key)).status),
    );
    expect(statuses.every((status) => status === 202 || status === 200)).toBe(
      true,
    );

    await waitFor(
      async () =>
        (await prisma.paymentAttempt.count({
          where: { status: 'PENDING' },
        })) === 0 && (await prisma.payment.count()) === PAYMENTS,
      { timeoutMs: 20_000, describe: () => outboxDiagnostics(prisma) },
    );
    await Promise.all(
      workers.map((context) => context.get(OutboxWorker).stop()),
    );

    await expect(
      prisma.payment.count({ where: { status: 'SUCCEEDED' } }),
    ).resolves.toBe(PAYMENTS);
    const submitted = provider.submissions.map((call) => call.attemptId);
    const looked = provider.lookups.map((call) => call.attemptId);
    expect(submitted).toHaveLength(PAYMENTS);
    expect(new Set(submitted).size).toBe(PAYMENTS);
    expect(looked).toHaveLength(PAYMENTS);
    expect(new Set(looked).size).toBe(PAYMENTS);

    const resolutions = await prisma.paymentEvent.groupBy({
      by: ['paymentId'],
      where: { type: 'attempt.resolved' },
      _count: { _all: true },
    });
    expect(resolutions).toHaveLength(PAYMENTS);
    expect(resolutions.every((row) => row._count._all === 1)).toBe(true);
    await expect(
      prisma.outboxJob.count({ where: { status: { not: 'COMPLETED' } } }),
    ).resolves.toBe(0);
    const workerRows = await prisma.outboxWorker.findMany();
    expect(workerRows).toHaveLength(2);
    expect(workerRows.every((row) => row.stoppedAt !== null)).toBe(true);
  }, 30_000);
});
