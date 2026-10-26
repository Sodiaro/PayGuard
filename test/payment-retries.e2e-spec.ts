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
import type { ErrorResponse } from '../src/common/http/error-response.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import { failWritesTo } from './support/db-faults.js';
import { drainOutbox, jobsOf } from './support/outbox.js';
import { paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';

describe('Payment retries (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let api: ReturnType<typeof paymentsApi>;
  let acme: Merchant;
  let globex: Merchant;

  beforeAll(async () => {
    app = await createTestApp({ provider });
    prisma = prismaOf(app);
    api = paymentsApi(app);
  });

  beforeEach(async () => {
    await resetDatabase();
    provider.reset();
    acme = await provisionMerchant(app, 'acme');
    globex = await provisionMerchant(app, 'globex');
  });

  afterAll(async () => {
    await app.close();
  });

  const failedPayment = async (outcome = SimulatorOutcome.Declined) => {
    provider.willReturn(outcome);
    const created = (await api.create(acme, 'create-key').expect(202))
      .body as PaymentResponse;
    await drainOutbox(app, prisma);
    provider.willReturn(SimulatorOutcome.Succeeded);
    return created;
  };

  const counts = async () => ({
    attempts: await prisma.paymentAttempt.count(),
    jobs: await prisma.outboxJob.count(),
    retryRequests: await prisma.paymentRetryRequest.count(),
  });

  it.each([SimulatorOutcome.Declined, SimulatorOutcome.Unavailable])(
    'retries a payment that FAILED with %s, keeping the failed attempt',
    async (outcome) => {
      const payment = await failedPayment(outcome);

      const response = await api.retry(acme, payment.id, 'retry-1').expect(202);
      expect(response.body).toMatchObject({
        status: 'PENDING',
        failureCode: null,
        attempts: [
          { attemptNumber: 1, status: 'FAILED' },
          { attemptNumber: 2, status: 'PENDING' },
        ],
      });

      await drainOutbox(app, prisma);
      const settled = await api.read(acme, payment.id);
      expect(settled).toMatchObject({
        status: 'SUCCEEDED',
        attempts: [
          {
            attemptNumber: 1,
            status: 'FAILED',
            failureCode:
              outcome === SimulatorOutcome.Declined
                ? 'DECLINED'
                : 'PROVIDER_UNAVAILABLE',
          },
          { attemptNumber: 2, status: 'SUCCEEDED' },
        ],
      });
      expect(provider.submissions.map((call) => call.attemptId)).toEqual(
        settled.attempts.map((attempt) => attempt.id),
      );
    },
  );

  it('refuses to retry a payment whose outcome is pending or unknown', async () => {
    const queued = (await api.create(acme, 'create-key').expect(202))
      .body as PaymentResponse;
    const response = await api.retry(acme, queued.id, 'retry-1').expect(409);
    expect((response.body as ErrorResponse).message).toBe(
      'Payment cannot be retried: payment_not_failed',
    );

    provider.willProcessThenTimeOut(SimulatorOutcome.Declined);
    await app.get(OutboxWorker).processDueJobs();
    await api.retry(acme, queued.id, 'retry-2').expect(409);
    await expect(counts()).resolves.toMatchObject({
      attempts: 1,
      retryRequests: 0,
    });
  });

  it('refuses to retry a succeeded payment', async () => {
    const payment = await failedPayment(SimulatorOutcome.Succeeded);

    const response = await api.retry(acme, payment.id, 'retry-1').expect(409);

    expect((response.body as ErrorResponse).message).toContain(
      'payment_not_failed',
    );
    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
  });

  it('enforces the attempt limit', async () => {
    const payment = await failedPayment();
    provider.willReturn(SimulatorOutcome.Declined);
    for (const key of ['retry-1', 'retry-2']) {
      await api.retry(acme, payment.id, key).expect(202);
      await drainOutbox(app, prisma);
    }

    const response = await api.retry(acme, payment.id, 'retry-3').expect(409);

    expect((response.body as ErrorResponse).message).toContain(
      'attempt_limit_reached',
    );
    await expect(counts()).resolves.toMatchObject({
      attempts: 3,
      retryRequests: 2,
    });
  });

  it('creates the retry attempt and its job atomically', async () => {
    const payment = await failedPayment();
    const before = await counts();
    const restore = await failWritesTo('outbox_jobs', 'INSERT');
    try {
      await api.retry(acme, payment.id, 'retry-1').expect(500);
    } finally {
      await restore();
    }

    await expect(counts()).resolves.toEqual(before);
    await expect(api.read(acme, payment.id)).resolves.toMatchObject({
      status: 'FAILED',
    });
    await api.retry(acme, payment.id, 'retry-1').expect(202);
  });

  describe('retry idempotency', () => {
    it('replays the same key without another attempt or job', async () => {
      const payment = await failedPayment();
      await api.retry(acme, payment.id, 'retry-1').expect(202);
      await drainOutbox(app, prisma);

      const replay = await api.retry(acme, payment.id, 'retry-1').expect(200);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect((replay.body as PaymentResponse).status).toBe('SUCCEEDED');
      await expect(counts()).resolves.toEqual({
        attempts: 2,
        jobs: 2,
        retryRequests: 1,
      });
    });

    it('returns 409 when the key is reused for a different payment', async () => {
      const first = await failedPayment();
      provider.willReturn(SimulatorOutcome.Declined);
      const second = (await api.create(acme, 'create-key-2').expect(202))
        .body as PaymentResponse;
      await drainOutbox(app, prisma);
      await api.retry(acme, first.id, 'retry-1').expect(202);

      const response = await api.retry(acme, second.id, 'retry-1').expect(409);

      expect((response.body as ErrorResponse).message).toContain(
        'different request',
      );
      await expect(api.read(acme, second.id)).resolves.toMatchObject({
        status: 'FAILED',
      });
    });

    it('keeps retry keys separate from the creation key', async () => {
      const payment = await failedPayment();

      await api.retry(acme, payment.id, 'create-key').expect(202);
      const creationReplay = await api.create(acme, 'create-key').expect(200);

      expect((creationReplay.body as PaymentResponse).id).toBe(payment.id);
      await expect(counts()).resolves.toMatchObject({
        attempts: 2,
        retryRequests: 1,
      });
    });

    it('creates one retry when the same key races', async () => {
      const payment = await failedPayment();

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => api.retry(acme, payment.id, 'retry-1')),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 202,
      ]);
      await expect(counts()).resolves.toEqual({
        attempts: 2,
        jobs: 2,
        retryRequests: 1,
      });
    });

    it('creates one retry when different keys race', async () => {
      const payment = await failedPayment();

      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          api.retry(acme, payment.id, `retry-${i}`),
        ),
      );

      expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
      await expect(counts()).resolves.toEqual({
        attempts: 2,
        jobs: 2,
        retryRequests: 1,
      });
      await expect(jobsOf(prisma)).resolves.toHaveLength(2);
    });
  });

  describe('access', () => {
    it("hides another merchant's payment behind the standard 404", async () => {
      const payment = await failedPayment();

      const foreign = await api
        .retry(globex, payment.id, 'retry-1')
        .expect(404);
      const missing = await api
        .retry(globex, '01890000-0000-7000-8000-000000000000', 'retry-1')
        .expect(404);

      expect((foreign.body as ErrorResponse).message).toBe('Payment not found');
      expect((missing.body as ErrorResponse).message).toBe('Payment not found');
      await expect(counts()).resolves.toMatchObject({
        attempts: 1,
        retryRequests: 0,
      });
    });

    it('requires a valid id, an Idempotency-Key and authentication', async () => {
      const payment = await failedPayment();

      await api.retry(acme, 'not-a-uuid', 'retry-1').expect(400);
      const missingKey = await api.retry(acme, payment.id).expect(400);
      expect((missingKey.body as ErrorResponse).details?.[0].field).toBe(
        'Idempotency-Key',
      );
      await api
        .retry({ ...acme, apiKey: 'pgsk_invalid' }, payment.id, 'retry-1')
        .expect(401);
    });
  });
});
