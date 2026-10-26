import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import { OutboxStore } from '../src/outbox/outbox-store.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import { makeJobsDue, processDueJobsExpecting } from './support/outbox.js';
import { paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  operatorOf,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';

// Hosts and database servers disagree in practice: a container VM paused while its host sleeps
// resumes with a lagging clock. PostgreSQL's clock decides job eligibility, leases and worker
// liveness, so none of them may depend on the application's clock agreeing with it. These tests
// move only the application's Date (timers stay real) and check every scheduling decision.
const SKEW_MS = 120_000;

function skewApplicationClock(offsetMs: number): void {
  jest.useFakeTimers({
    now: Date.now() + offsetMs,
    advanceTimers: true,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
}

describe('Scheduling when the application clock disagrees with PostgreSQL', () => {
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
    await resetDatabase();
    provider.reset();
    acme = await provisionMerchant(app, 'acme');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
  });

  const create = async () =>
    (await api.create(acme, 'key-1').expect(202)).body as PaymentResponse;

  it.each([
    ['ahead of', SKEW_MS],
    ['behind', -SKEW_MS],
  ])(
    'makes new work due at once with the application clock %s the database',
    async (_case, offset) => {
      skewApplicationClock(offset);
      const payment = await create();

      await processDueJobsExpecting(app, prisma, 1);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
    },
  );

  it('keeps a delayed lookup waiting its full delay with the application clock behind', async () => {
    skewApplicationClock(-SKEW_MS);
    provider.willProcessThenTimeOut(SimulatorOutcome.Succeeded);
    await create();
    await processDueJobsExpecting(app, prisma, 1);

    // RECONCILIATION_DELAY_SECONDS is 60, less than the skew: a lookup scheduled from the
    // application clock would already look overdue to the database.
    await processDueJobsExpecting(app, prisma, 0);
    expect(provider.lookups).toHaveLength(0);
  });

  it('measures retry backoff on the database clock', async () => {
    skewApplicationClock(-SKEW_MS);
    provider.willProcessThenTimeOut(SimulatorOutcome.Succeeded);
    await create();
    await worker.processDueJobs();
    provider.willLookup({ status: 'processing' });
    await makeJobsDue(prisma);
    await processDueJobsExpecting(app, prisma, 1);

    await processDueJobsExpecting(app, prisma, 0);
    expect(provider.lookups).toHaveLength(1);
  });

  it('makes a requeued job due at once with the application clock ahead', async () => {
    provider.willProcessThenTimeOut(SimulatorOutcome.Succeeded);
    await create();
    await worker.processDueJobs();
    await prisma.outboxJob.updateMany({
      where: { type: 'RECONCILE_ATTEMPT' },
      data: { status: 'DEAD', runCount: 10 },
    });
    const dead = await prisma.outboxJob.findFirstOrThrow({
      where: { status: 'DEAD' },
    });

    skewApplicationClock(SKEW_MS);
    await expect(
      operatorOf(app).get(OutboxStore).requeueDead(dead.id, 'test-operator'),
    ).resolves.toBe(true);
    await processDueJobsExpecting(app, prisma, 1);
  });

  it.each([
    ['ahead of', SKEW_MS],
    ['behind', -SKEW_MS],
  ])(
    'reports a worker that just sent a heartbeat as active with the application clock %s the database',
    async (_case, offset) => {
      skewApplicationClock(offset);
      await worker.recordHeartbeat();

      const health = await request(app.getHttpServer())
        .get('/health')
        .expect(200);
      expect(health.body).toMatchObject({
        details: { workers: { status: 'up' } },
      });
      await expect(
        app.get(OutboxStore).workerSnapshot(30),
      ).resolves.toMatchObject({ activeWorkers: 1 });
    },
  );

  it('does not count a worker silent for longer than the timeout as active, whatever the application clock says', async () => {
    await worker.recordHeartbeat();
    await prisma.$executeRaw`
      UPDATE outbox_workers SET heartbeat_at = now() - interval '5 minutes'`;

    skewApplicationClock(-10 * 60_000);
    await expect(
      app.get(OutboxStore).workerSnapshot(30),
    ).resolves.toMatchObject({ activeWorkers: 0 });
  });
});
