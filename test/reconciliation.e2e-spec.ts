import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import { OutboxStore } from '../src/outbox/outbox-store.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { ProviderTimeoutError } from '../src/payments/providers/payment-provider.js';
import {
  SimulatedPaymentProvider,
  SimulatorOutcome,
} from '../src/payments/providers/simulated-payment-provider.js';
import {
  ageAttempts,
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
import { ownerDatabase, resetDatabase } from './support/test-database.js';

describe('Reconciliation of unknown outcomes (PostgreSQL)', () => {
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

  afterAll(async () => {
    await app.close();
  });

  const createPayment = async () =>
    (await api.create(acme, 'key-1').expect(202)).body as PaymentResponse;

  // Submits the payment, losing the provider's answer, so the attempt awaits reconciliation.
  const createAmbiguousPayment = async (
    outcome = SimulatorOutcome.Succeeded,
  ) => {
    provider.willProcessThenTimeOut(outcome);
    const payment = await createPayment();
    await worker.processDueJobs();
    return payment;
  };

  const reconcileOnce = async () => {
    await makeJobsDue(prisma);
    return worker.processDueJobs();
  };

  it('defers an ambiguous submission to a delayed lookup instead of guessing', async () => {
    const payment = await createAmbiguousPayment();

    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'PENDING',
      attempts: [{ status: 'PENDING' }],
    });
    const jobs = await jobsOf(prisma);
    expect(jobs).toEqual([
      expect.objectContaining({ type: 'PROCESS_ATTEMPT', status: 'COMPLETED' }),
      expect.objectContaining({
        type: 'RECONCILE_ATTEMPT',
        status: 'QUEUED',
        runCount: 0,
      }),
    ]);
    await expect(worker.processDueJobs()).resolves.toBe(0);
  });

  it.each([
    [SimulatorOutcome.Succeeded, 'SUCCEEDED', null],
    [SimulatorOutcome.Declined, 'FAILED', 'DECLINED'],
  ])(
    'applies a confirmed %s found by lookup',
    async (outcome, status, failureCode) => {
      const payment = await createAmbiguousPayment(outcome);

      await reconcileOnce();

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status,
        failureCode,
        attempts: [
          { status, providerReference: expect.stringMatching(/^sim_/) },
        ],
      });
      expect(provider.submissions).toHaveLength(1);
      expect(provider.lookups).toHaveLength(1);
    },
  );

  it.each([
    [
      'still processing',
      { status: 'processing' as const },
      'OUTCOME_PROCESSING',
    ],
    ['unavailable', { status: 'unavailable' as const }, 'PROVIDER_UNAVAILABLE'],
    ['timing out', new ProviderTimeoutError(), 'PROVIDER_TIMEOUT'],
    ['failing', new Error('lookup endpoint 500'), 'PROVIDER_ERROR'],
  ])(
    'keeps the attempt PENDING while lookup is %s',
    async (_case, answer, category) => {
      const payment = await createAmbiguousPayment();
      provider.willLookup(answer);

      await reconcileOnce();

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      const reconcile = (await jobsOf(prisma)).find(
        (job) => job.type === 'RECONCILE_ATTEMPT',
      );
      expect(reconcile).toMatchObject({
        status: 'QUEUED',
        runCount: 1,
        lastError: category,
      });

      await reconcileOnce();
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
    },
  );

  it('leaves an attempt PENDING and visible once automatic reconciliation gives up', async () => {
    const payment = await createAmbiguousPayment();
    provider.willLookup(
      ...Array.from({ length: 10 }, () => ({ status: 'processing' as const })),
    );

    for (let run = 0; run < 10; run++) await reconcileOnce();

    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'PENDING',
    });
    const reconcile = (await jobsOf(prisma)).find(
      (job) => job.type === 'RECONCILE_ATTEMPT',
    );
    expect(reconcile).toMatchObject({
      status: 'DEAD',
      runCount: 10,
      lastError: 'OUTCOME_PROCESSING',
    });

    const stats = await app.get(OutboxStore).stats();
    expect(stats).toMatchObject({
      deadJobs: 1,
      unresolvedAttempts: 1,
      reconciliationLookups: 10,
    });
    expect(stats.oldestUnresolvedAttemptAgeSeconds).toEqual(expect.any(Number));

    await expect(worker.sweepStaleAttempts()).resolves.toBe(0);
  });

  it('resubmits under the same attempt ID only when the provider has no record of it', async () => {
    provider.willThrow(
      new Error('connection reset before the request was sent'),
    );
    const payment = await createPayment();
    await worker.processDueJobs();
    provider.willReturn(SimulatorOutcome.Succeeded);

    await reconcileOnce();

    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
    expect(provider.submissions.map((call) => call.attemptId)).toEqual([
      payment.attempts[0].id,
      payment.attempts[0].id,
    ]);
    await expect(prisma.paymentAttempt.count()).resolves.toBe(1);
  });

  it.each([SimulatorOutcome.Succeeded, SimulatorOutcome.Declined])(
    'records a %s exactly once when the worker stalls after the provider processed it',
    async (outcome) => {
      provider.willReturn(outcome);
      const payment = await createPayment();
      const stalled = provider.hold();
      const stalledRun = worker.processDueJobs();
      await stalled.entered;

      await expireLeases(prisma);
      await worker.processDueJobs();
      await reconcileOnce();

      const recovered = await api.read(acme, payment.id);
      expect(recovered.status).toBe(
        outcome === SimulatorOutcome.Succeeded ? 'SUCCEEDED' : 'FAILED',
      );
      expect(provider.submissions).toHaveLength(1);
      expect(provider.lookups).toHaveLength(1);

      stalled.release();
      await stalledRun;
      await expect(api.read(acme, payment.id)).resolves.toEqual(recovered);
      await expect(jobsOf(prisma)).resolves.toEqual([
        expect.objectContaining({
          type: 'PROCESS_ATTEMPT',
          status: 'COMPLETED',
          lastError: 'LEASE_EXPIRED',
        }),
        expect.objectContaining({
          type: 'RECONCILE_ATTEMPT',
          status: 'COMPLETED',
        }),
      ]);
    },
  );

  it('applies exactly one outcome when reconciliation races a recorded result', async () => {
    const payment = await createAmbiguousPayment();
    await makeJobsDue(prisma);

    const [, applied] = await Promise.all([
      worker.processDueJobs(),
      app.get(PaymentsService).recordAttemptOutcome(payment.attempts[0].id, {
        outcome: 'declined',
        providerReference: 'sim_late',
      }),
    ]);

    const settled = await api.read(acme, payment.id);
    expect(settled.status).toBe(applied ? 'FAILED' : 'SUCCEEDED');
    expect(settled.attempts[0].status).toBe(settled.status);
    const reconcile = (await jobsOf(prisma)).find(
      (job) => job.type === 'RECONCILE_ATTEMPT',
    );
    expect(reconcile?.status).toBe('COMPLETED');
  });

  it('sweeps stale pending attempts that have no live job into reconciliation', async () => {
    const payment = await createPayment();
    await ownerDatabase().outboxJob.deleteMany();
    provider.ledger.set(payment.attempts[0].id, {
      outcome: 'succeeded',
      providerReference: 'sim_swept',
    });

    await expect(worker.sweepStaleAttempts()).resolves.toBe(0);
    await ageAttempts(3600);
    await expect(worker.sweepStaleAttempts()).resolves.toBe(1);
    await expect(worker.sweepStaleAttempts()).resolves.toBe(0);

    await drainOutbox(app, prisma);
    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      attempts: [{ providerReference: 'sim_swept' }],
    });
    expect(provider.submissions).toHaveLength(0);
  });
});

describe('Recovery across a restart with the simulated provider', () => {
  it('resolves an ambiguous submission from a fresh process', async () => {
    const before = await createTestApp({
      provider: new SimulatedPaymentProvider(SimulatorOutcome.Succeeded, true),
    });
    await resetDatabase();
    const merchant = await provisionMerchant(before, 'acme');
    const created = (
      await paymentsApi(before).create(merchant, 'key-1').expect(202)
    ).body as PaymentResponse;
    await before.get(OutboxWorker).processDueJobs();
    await before.close();

    const after = await createTestApp({
      provider: new SimulatedPaymentProvider(SimulatorOutcome.Succeeded, true),
    });
    try {
      await drainOutbox(after, prismaOf(after));
      await expect(
        paymentsApi(after).read(merchant, created.id),
      ).resolves.toMatchObject({
        status: 'SUCCEEDED',
        attempts: [
          {
            status: 'SUCCEEDED',
            providerReference: expect.stringMatching(/^sim_/),
          },
        ],
      });
    } finally {
      await after.close();
    }
  });
});
