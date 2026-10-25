import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { App } from 'supertest/types.js';
import {
  SimulatedWebhookSender,
  SimulatorWebhookError,
} from '../src/cli/simulated-webhook-sender.js';
import type { CoreEnvironment } from '../src/config/environment.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import { OutboxStore } from '../src/outbox/outbox-store.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import type { ProviderWebhookEvent } from '../src/webhooks/provider-webhook.requests.js';
import { ProviderWebhookProcessor } from '../src/webhooks/provider-webhook-processor.js';
import { WorkerModule } from '../src/worker.module.js';
import { runCli } from './support/admin-cli.js';
import { failWritesTo } from './support/db-faults.js';
import { drainOutbox, expireLeases, makeJobsDue } from './support/outbox.js';
import { paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';
import { eventFor, webhooksApi } from './support/webhooks.js';

describe('Provider webhook processing (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let api: ReturnType<typeof paymentsApi>;
  let webhooks: ReturnType<typeof webhooksApi>;
  let worker: OutboxWorker;
  let acme: Merchant;
  let keys = 0;

  beforeAll(async () => {
    app = await createTestApp({ provider });
    prisma = prismaOf(app);
    api = paymentsApi(app);
    webhooks = webhooksApi(app);
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

  const create = async (merchant = acme) =>
    (await api.create(merchant, `key-${++keys}`).expect(202))
      .body as PaymentResponse;

  // The provider processed the payment (its ledger has the outcome) but the answer was lost, so
  // the attempt is PENDING with a delayed reconciliation lookup queued.
  const createAwaitingPayment = async (
    outcome = SimulatorOutcome.Succeeded,
    merchant = acme,
  ) => {
    provider.willProcessThenTimeOut(outcome);
    const payment = await create(merchant);
    await worker.processDueJobs();
    return payment;
  };

  const createSettledPayment = async (outcome: SimulatorOutcome) => {
    provider.willReturn(outcome);
    const payment = await create();
    await drainOutbox(app, prisma);
    return api.read(acme, payment.id);
  };

  // Webhook jobs are due at once; the reconciliation lookup is still delayed, so only they run.
  const processWebhooks = () => worker.processDueJobs();

  const deliver = async (event: ProviderWebhookEvent) => {
    const response = await webhooks.deliver(event);
    expect([200, 202]).toContain(response.status);
  };

  const storedEvent = (event: ProviderWebhookEvent) =>
    prisma.providerWebhookEvent.findFirstOrThrow({
      where: { eventId: event.id },
    });

  const attemptOf = (payment: PaymentResponse) =>
    prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: payment.attempts.at(-1)!.id },
    });

  const reconcileJob = (payment: PaymentResponse) =>
    prisma.outboxJob.findFirst({
      where: {
        attemptId: payment.attempts.at(-1)!.id,
        type: 'RECONCILE_ATTEMPT',
      },
    });

  describe('payment integrity', () => {
    it('records a success through the lifecycle and leaves nothing for reconciliation to do', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');

      await deliver(event);
      await processWebhooks();

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        attempts: [
          {
            status: 'SUCCEEDED',
            providerReference: event.data.providerReference,
            completedAt: expect.any(String) as unknown as string,
          },
        ],
      });
      await expect(storedEvent(event)).resolves.toMatchObject({
        status: 'PROCESSED',
        result: 'APPLIED',
        processedAt: expect.any(Date) as unknown as Date,
      });

      await drainOutbox(app, prisma);
      expect(provider.lookups).toHaveLength(0);
    });

    it('records a decline, after which the payment can be retried as usual', async () => {
      const payment = await createAwaitingPayment(SimulatorOutcome.Declined);

      await deliver(eventFor(payment, 'payment.declined'));
      await processWebhooks();

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
      });
      await api.retry(acme, payment.id, 'retry-1').expect(202);
    });

    it('never lets a later decline overwrite a confirmed success', async () => {
      const payment = await createSettledPayment(SimulatorOutcome.Succeeded);
      const before = await attemptOf(payment);
      const event = eventFor(payment, 'payment.declined');

      await deliver(event);
      await processWebhooks();

      await expect(storedEvent(event)).resolves.toMatchObject({
        result: 'OUTCOME_CONFLICT',
      });
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        failureCode: null,
      });
      await expect(attemptOf(payment)).resolves.toEqual(before);
    });

    it('records a late success on a declined payment as a conflict and changes nothing', async () => {
      const payment = await createSettledPayment(SimulatorOutcome.Declined);
      const before = await attemptOf(payment);
      const event = eventFor(payment, 'payment.succeeded');

      await deliver(event);
      await processWebhooks();

      await expect(storedEvent(event)).resolves.toMatchObject({
        result: 'OUTCOME_CONFLICT',
      });
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
      });
      await expect(attemptOf(payment)).resolves.toEqual(before);
    });

    it('acknowledges a notification of an outcome already recorded', async () => {
      const payment = await createSettledPayment(SimulatorOutcome.Succeeded);
      const before = await attemptOf(payment);
      const event = eventFor(payment, 'payment.succeeded');

      await deliver(event);
      await processWebhooks();

      await expect(storedEvent(event)).resolves.toMatchObject({
        result: 'ALREADY_APPLIED',
      });
      await expect(attemptOf(payment)).resolves.toEqual(before);
    });

    it('only changes the attempt the event names, never another payment', async () => {
      const globex = await provisionMerchant(app, 'globex');
      const ours = await createAwaitingPayment();
      const theirs = await createAwaitingPayment(
        SimulatorOutcome.Succeeded,
        globex,
      );

      await deliver(eventFor(theirs, 'payment.succeeded'));
      await processWebhooks();

      await expect(api.read(globex, theirs.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      await expect(api.read(acme, ours.id)).resolves.toMatchObject({
        status: 'PENDING',
        attempts: [{ status: 'PENDING' }],
      });
    });

    it.each([
      ['amount', { amount: 500001 }],
      ['currency', { currency: 'GHS' as const }],
    ])(
      'does not apply an event whose %s differs; a provider lookup decides instead',
      async (_field, change) => {
        // The provider's own record says declined; the mismatched event claims success.
        const payment = await createAwaitingPayment(SimulatorOutcome.Declined);
        const genuine = eventFor(payment, 'payment.succeeded');
        const event = { ...genuine, data: { ...genuine.data, ...change } };

        await deliver(event);
        await processWebhooks();

        await expect(storedEvent(event)).resolves.toMatchObject({
          result: 'DATA_MISMATCH',
        });
        await expect(api.read(acme, payment.id)).resolves.toMatchObject({
          status: 'PENDING',
        });
        await expect(reconcileJob(payment)).resolves.toMatchObject({
          status: 'QUEUED',
        });

        await drainOutbox(app, prisma);
        await expect(api.read(acme, payment.id)).resolves.toMatchObject({
          status: 'FAILED',
          failureCode: 'DECLINED',
        });
        expect(provider.lookups).toHaveLength(1);
      },
    );

    it('distrusts an event whose ID was reused with other content; the lookup decides', async () => {
      const payment = await createAwaitingPayment(SimulatorOutcome.Declined);
      const event = eventFor(payment, 'payment.succeeded');

      await deliver(event);
      await webhooks
        .deliver({ ...event, data: { ...event.data, amount: 1 } })
        .expect(409);
      await processWebhooks();

      await expect(storedEvent(event)).resolves.toMatchObject({
        result: 'PAYLOAD_CONFLICT',
      });
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      await drainOutbox(app, prisma);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
      });
    });

    it('keeps the attempt PENDING when the lookup cannot establish the outcome either', async () => {
      const payment = await createAwaitingPayment();
      const genuine = eventFor(payment, 'payment.succeeded');

      await deliver({ ...genuine, data: { ...genuine.data, amount: 1 } });
      await processWebhooks();
      provider.willLookup({ status: 'processing' });
      await makeJobsDue(prisma);
      await worker.processDueJobs();

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'PENDING',
        attempts: [{ status: 'PENDING' }],
      });
      await expect(reconcileJob(payment)).resolves.toMatchObject({
        status: 'QUEUED',
        lastError: 'OUTCOME_PROCESSING',
      });
    });
  });

  describe('out-of-order delivery', () => {
    it('ignores a processing notice that arrives after the outcome', async () => {
      const payment = await createAwaitingPayment();
      const earlier = new Date(Date.now() - 5000);
      const processing = eventFor(payment, 'payment.processing', earlier);
      const succeeded = eventFor(payment, 'payment.succeeded');

      await deliver(succeeded);
      await processWebhooks();
      await deliver(processing);
      await processWebhooks();

      await expect(storedEvent(processing)).resolves.toMatchObject({
        result: 'NO_ACTION',
      });
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
    });

    it('applies the outcome when the processing notice comes first', async () => {
      const payment = await createAwaitingPayment();
      const processing = eventFor(payment, 'payment.processing');
      const succeeded = eventFor(payment, 'payment.succeeded');

      await deliver(processing);
      await processWebhooks();
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      await deliver(succeeded);
      await processWebhooks();

      await expect(storedEvent(processing)).resolves.toMatchObject({
        result: 'NO_ACTION',
      });
      await expect(storedEvent(succeeded)).resolves.toMatchObject({
        result: 'APPLIED',
      });
    });

    it('applies exactly one of two contradictory outcomes processed together', async () => {
      const payment = await createAwaitingPayment();
      const succeeded = eventFor(payment, 'payment.succeeded');
      const declined = eventFor(payment, 'payment.declined');

      await deliver(succeeded);
      await deliver(declined);
      await processWebhooks();

      const results = [
        (await storedEvent(succeeded)).result,
        (await storedEvent(declined)).result,
      ].sort();
      expect(results).toEqual(['APPLIED', 'OUTCOME_CONFLICT']);
      const attempt = await attemptOf(payment);
      const current = await api.read(acme, payment.id);
      expect(attempt.status).not.toBe('PENDING');
      expect(current.status).toBe(attempt.status);
    });
  });

  describe('concurrency and recovery', () => {
    it('applies each outcome once when webhooks race reconciliation lookups', async () => {
      const payments = [];
      for (let i = 0; i < 4; i++) payments.push(await createAwaitingPayment());
      for (const payment of payments) {
        await deliver(eventFor(payment, 'payment.succeeded'));
      }

      // Webhook jobs and lookups are all due: one batch runs them concurrently.
      await makeJobsDue(prisma);
      await expect(worker.processDueJobs()).resolves.toBe(8);

      for (const payment of payments) {
        await expect(api.read(acme, payment.id)).resolves.toMatchObject({
          status: 'SUCCEEDED',
          attempts: [{ status: 'SUCCEEDED' }],
        });
        const { result } = await storedEvent(
          eventFor(payment, 'payment.succeeded'),
        );
        expect(['APPLIED', 'ALREADY_APPLIED']).toContain(result);
      }
      const jobs = await prisma.outboxJob.findMany();
      expect(jobs.every((job) => job.status === 'COMPLETED')).toBe(true);
    });

    it('keeps payment invariants when a webhook and a lookup disagree and race', async () => {
      const payment = await createAwaitingPayment(SimulatorOutcome.Declined);
      const event = eventFor(payment, 'payment.succeeded');

      await deliver(event);
      await makeJobsDue(prisma);
      await worker.processDueJobs();

      const attempt = await attemptOf(payment);
      const current = await api.read(acme, payment.id);
      const { result } = await storedEvent(event);
      expect(attempt.status).not.toBe('PENDING');
      expect(current.status).toBe(attempt.status);
      expect(result).toBe(
        attempt.status === 'SUCCEEDED' ? 'APPLIED' : 'OUTCOME_CONFLICT',
      );
    });

    it('does not apply an event twice when a stalled worker resumes after another took over', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');
      await deliver(event);

      const [stalled] = await app.get(OutboxStore).claim('stalled-worker', 10);
      expect(stalled.type).toBe('APPLY_WEBHOOK_EVENT');
      await expireLeases(prisma);
      await processWebhooks();
      const applied = await attemptOf(payment);
      const processed = await storedEvent(event);

      await app.get(ProviderWebhookProcessor).process(stalled);

      await expect(attemptOf(payment)).resolves.toEqual(applied);
      await expect(storedEvent(event)).resolves.toEqual(processed);
      expect(processed).toMatchObject({ result: 'APPLIED' });
      await expect(
        prisma.outboxJob.findUniqueOrThrow({ where: { id: stalled.id } }),
      ).resolves.toMatchObject({ status: 'COMPLETED', leaseRecoveries: 1 });
    });

    it('rolls back a processing failure entirely and retries it', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');
      await deliver(event);

      const restore = await failWritesTo(
        prisma,
        'provider_webhook_events',
        'UPDATE',
      );
      try {
        await processWebhooks();
      } finally {
        await restore();
      }

      // The attempt update ran before the failing write, in the same transaction.
      await expect(attemptOf(payment)).resolves.toMatchObject({
        status: 'PENDING',
      });
      await expect(storedEvent(event)).resolves.toMatchObject({
        status: 'RECEIVED',
      });
      const job = await prisma.outboxJob.findFirstOrThrow({
        where: { type: 'APPLY_WEBHOOK_EVENT' },
      });
      expect(job).toMatchObject({
        status: 'QUEUED',
        lastError: 'INTERNAL_ERROR',
      });

      await prisma.outboxJob.update({
        where: { id: job.id },
        data: { availableAt: new Date(Date.now() - 1000) },
      });
      await processWebhooks();
      await expect(storedEvent(event)).resolves.toMatchObject({
        result: 'APPLIED',
      });
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
    });

    it('recovers an event whose worker died mid-job through lease expiry', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');
      await deliver(event);

      await app.get(OutboxStore).claim('crashed-worker', 10);
      await expect(processWebhooks()).resolves.toBe(0);
      await expireLeases(prisma);
      await expect(processWebhooks()).resolves.toBe(1);

      await expect(storedEvent(event)).resolves.toMatchObject({
        result: 'APPLIED',
      });
    });

    it('is processed by the standalone worker like any other outbox job', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');
      await deliver(event);

      const standalone = await NestFactory.createApplicationContext(
        WorkerModule,
        { logger: false },
      );
      try {
        await expect(
          standalone.get(OutboxWorker).processDueJobs(),
        ).resolves.toBe(1);
      } finally {
        await standalone.close();
      }

      await expect(storedEvent(event)).resolves.toMatchObject({
        result: 'APPLIED',
      });
    });
  });

  describe('operations', () => {
    it('shows processing results in ops:status and ops:metrics', async () => {
      const payment = await createSettledPayment(SimulatorOutcome.Succeeded);
      await deliver(eventFor(payment, 'payment.declined'));
      await processWebhooks();

      const status = await runCli(app, 'ops:status');
      expect(status.out).toMatch(/PROCESSED\s+OUTCOME_CONFLICT\s+1/);
      const metrics = await runCli(app, 'ops:metrics');
      expect(metrics.out).toContain(
        'payguard_webhook_events{status="PROCESSED",result="OUTCOME_CONFLICT"} 1',
      );
    });

    it('delivers a signed simulator event over HTTP from the operator CLI', async () => {
      const payment = await createAwaitingPayment();
      await app.listen(0, '127.0.0.1');
      const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;

      const first = await runCli(
        app,
        'simulator:webhook',
        '--attempt',
        payment.attempts[0].id,
        '--url',
        url,
      );
      const again = await runCli(
        app,
        'simulator:webhook',
        '--attempt',
        payment.attempts[0].id,
        '--url',
        url,
      );

      expect(first).toMatchObject({ code: 0 });
      expect(first.out).toMatch(
        /^Delivered evt_[0-9a-f]{24} \(payment\.succeeded\): HTTP 202 accepted$/,
      );
      expect(again.out).toContain('HTTP 200 duplicate');
      await processWebhooks();
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
    });

    it('refuses to send simulator webhooks in production', async () => {
      const production = {
        get: (key: string) => (key === 'NODE_ENV' ? 'production' : undefined),
      } as unknown as ConfigService<CoreEnvironment, true>;
      const sender = new SimulatedWebhookSender(prisma, production);

      await expect(
        sender.send({
          attemptId: '019a0000-0000-7000-8000-000000000000',
          baseUrl: 'http://127.0.0.1:1',
        }),
      ).rejects.toThrow(SimulatorWebhookError);
    });

    it('fails the CLI command for an unknown attempt', async () => {
      const result = await runCli(
        app,
        'simulator:webhook',
        '--attempt',
        '019a0000-0000-7000-8000-000000000000',
      );

      expect(result.code).toBe(1);
      expect(result.err).toContain('No simulator attempt');
    });
  });
});
