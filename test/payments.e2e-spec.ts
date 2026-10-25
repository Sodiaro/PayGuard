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
import type { ErrorResponse } from '../src/common/http/error-response.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import { MAX_PAYMENT_AMOUNT } from '../src/payments/currencies.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import { drainOutbox, jobsOf } from './support/outbox.js';
import { ORDER, paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';

describe('Payments API (PostgreSQL)', () => {
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
    await resetDatabase(prisma);
    provider.reset();
    acme = await provisionMerchant(app, 'acme');
    globex = await provisionMerchant(app, 'globex');
  });

  afterAll(async () => {
    await app.close();
  });

  const counts = async () => ({
    payments: await prisma.payment.count(),
    attempts: await prisma.paymentAttempt.count(),
    jobs: await prisma.outboxJob.count(),
  });

  // With one attempt per payment, the attempt and its payment must always agree.
  const expectConsistentState = async () => {
    const rows = await prisma.$queryRaw<{ payment: string; attempt: string }[]>`
      SELECT p.status::text AS payment, a.status::text AS attempt
      FROM payments p JOIN payment_attempts a ON a.payment_id = p.id`;
    for (const row of rows) expect(row.attempt).toBe(row.payment);
  };

  describe('creating a payment', () => {
    it('accepts it with 202 and queues its first attempt, without contacting the provider', async () => {
      const response = await api.create(acme, 'key-1').expect(202);
      const payment = response.body as PaymentResponse;

      expect(payment).toEqual({
        id: expect.any(String),
        amount: 500000,
        currency: 'NGN',
        status: 'PENDING',
        reference: 'order_10042',
        failureCode: null,
        attempts: [
          {
            id: expect.any(String),
            attemptNumber: 1,
            provider: 'simulator',
            status: 'PENDING',
            providerReference: null,
            failureCode: null,
            createdAt: expect.any(String),
            completedAt: null,
          },
        ],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(response.headers).not.toHaveProperty('idempotent-replayed');
      expect(provider.submissions).toHaveLength(0);
      await expect(jobsOf(prisma)).resolves.toEqual([
        expect.objectContaining({
          type: 'PROCESS_ATTEMPT',
          status: 'QUEUED',
          attemptId: payment.attempts[0].id,
          requestId: response.headers['x-request-id'],
        }),
      ]);
    });

    it('is processed by the worker into a SUCCEEDED payment', async () => {
      const created = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;

      await drainOutbox(app, prisma);

      const payment = await api.read(acme, created.id);
      expect(payment).toMatchObject({
        status: 'SUCCEEDED',
        failureCode: null,
        attempts: [
          {
            status: 'SUCCEEDED',
            providerReference: expect.stringMatching(/^sim_[0-9a-f]{24}$/),
            completedAt: expect.any(String),
          },
        ],
      });
      expect(provider.submissions).toEqual([
        {
          attemptId: created.attempts[0].id,
          merchantId: acme.merchantId,
          amount: 500000,
          currency: 'NGN',
        },
      ]);
      await expect(jobsOf(prisma)).resolves.toEqual([
        expect.objectContaining({ status: 'COMPLETED', runCount: 1 }),
      ]);
      await expectConsistentState();
    });

    it('stores amounts as exact integers in every currency exponent', async () => {
      for (const [key, body] of [
        ['jpy', { amount: 500, currency: 'JPY' }],
        ['kwd', { amount: 1500, currency: 'KWD' }],
        ['max', { amount: MAX_PAYMENT_AMOUNT, currency: 'USD' }],
      ] as const) {
        const response = await api.create(acme, key, body).expect(202);
        expect((response.body as PaymentResponse).amount).toBe(body.amount);
      }
      const stored = await prisma.payment.findMany({
        select: { amount: true },
      });
      expect(stored.map((p) => p.amount).sort()).toEqual(
        [500n, 1500n, BigInt(MAX_PAYMENT_AMOUNT)].sort(),
      );
    });

    it('requires an API key before anything else', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/payments')
        .send(ORDER)
        .expect(401);

      expect((response.body as ErrorResponse).message).toBe('Missing API key');
    });

    it.each([
      ['missing', undefined, 'required'],
      ['blank', '   ', 'required'],
      ['too long', 'k'.repeat(256), 'visible ASCII'],
      ['containing spaces', 'two words', 'visible ASCII'],
    ])('rejects a %s Idempotency-Key', async (_case, key, message) => {
      const response = await api.create(acme, key).expect(400);
      const body = response.body as ErrorResponse;

      expect(body).toMatchObject({
        statusCode: 400,
        message: 'Validation failed',
      });
      expect(body.details).toEqual([
        {
          field: 'Idempotency-Key',
          messages: [expect.stringContaining(message)],
        },
      ]);
      await expect(counts()).resolves.toEqual({
        payments: 0,
        attempts: 0,
        jobs: 0,
      });
    });

    it.each([
      ['zero amount', { ...ORDER, amount: 0 }, ['amount']],
      ['negative amount', { ...ORDER, amount: -500 }, ['amount']],
      ['fractional amount', { ...ORDER, amount: 10.5 }, ['amount']],
      ['amount as string', { ...ORDER, amount: '500000' }, ['amount']],
      [
        'amount above maximum',
        { ...ORDER, amount: MAX_PAYMENT_AMOUNT + 1 },
        ['amount'],
      ],
      ['unsupported currency', { ...ORDER, currency: 'XYZ' }, ['currency']],
      ['lowercase currency', { ...ORDER, currency: 'ngn' }, ['currency']],
      ['missing fields', {}, ['amount', 'currency']],
      ['client-chosen status', { ...ORDER, status: 'SUCCEEDED' }, ['status']],
      ['client-chosen merchant', { ...ORDER, merchantId: 'x' }, ['merchantId']],
    ])('rejects a %s', async (_case, body, fields) => {
      const response = await api.create(acme, 'key-invalid', body).expect(400);

      expect(
        (response.body as ErrorResponse).details?.map((d) => d.field),
      ).toEqual(fields);
      await expect(counts()).resolves.toEqual({
        payments: 0,
        attempts: 0,
        jobs: 0,
      });
    });

    it('rejects malformed JSON with the standard envelope', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acme.apiKey}`)
        .set('Idempotency-Key', 'key-json')
        .set('Content-Type', 'application/json')
        .send('{"amount": 5')
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        path: '/v1/payments',
      });
      await expect(counts()).resolves.toEqual({
        payments: 0,
        attempts: 0,
        jobs: 0,
      });
    });
  });

  describe('provider outcomes', () => {
    it('records a decline as FAILED/DECLINED with the provider reference', async () => {
      provider.willReturn(SimulatorOutcome.Declined);
      const created = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;

      await drainOutbox(app, prisma);

      const payment = await api.read(acme, created.id);
      expect(payment).toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
      });
      expect(payment.attempts[0]).toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
        providerReference: expect.stringMatching(/^sim_/),
      });
      await expectConsistentState();
    });

    it('records an outage as PROVIDER_UNAVAILABLE, never as a decline', async () => {
      provider.willReturn(SimulatorOutcome.Unavailable);
      const created = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;

      await drainOutbox(app, prisma);

      const payment = await api.read(acme, created.id);
      expect(payment).toMatchObject({
        status: 'FAILED',
        failureCode: 'PROVIDER_UNAVAILABLE',
      });
      expect(payment.attempts[0]).toMatchObject({ providerReference: null });
      await expectConsistentState();
    });

    it('never exposes provider error details to the client', async () => {
      provider.willThrow(
        new Error('gateway said: card 4111111111111111 cvv 123 rejected'),
      );
      const created = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;

      await app.get(OutboxWorker).processDueJobs();
      const response = await api.get(acme, created.id).expect(200);

      expect((response.body as PaymentResponse).status).toBe('PENDING');
      expect(response.text).not.toMatch(/4111|cvv|gateway/);
      const stored = JSON.stringify(await prisma.outboxJob.findMany());
      expect(stored).not.toMatch(/4111|cvv|gateway/);
    });
  });

  describe('idempotency', () => {
    it('replays the same request without a second payment, job or provider call', async () => {
      const first = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;
      await drainOutbox(app, prisma);

      const replay = await api
        .create(acme, 'key-1', {
          reference: 'order_10042',
          currency: 'NGN',
          amount: 500000,
        })
        .expect(200);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect((replay.body as PaymentResponse).id).toBe(first.id);
      expect((replay.body as PaymentResponse).status).toBe('SUCCEEDED');
      await drainOutbox(app, prisma);
      expect(provider.submissions).toHaveLength(1);
      await expect(counts()).resolves.toEqual({
        payments: 1,
        attempts: 1,
        jobs: 1,
      });
    });

    it('replays a queued payment as PENDING without queuing more work', async () => {
      await api.create(acme, 'key-1').expect(202);

      const replay = await api.create(acme, 'key-1').expect(200);

      expect((replay.body as PaymentResponse).status).toBe('PENDING');
      await expect(counts()).resolves.toEqual({
        payments: 1,
        attempts: 1,
        jobs: 1,
      });
    });

    it.each([
      ['amount', { ...ORDER, amount: 500001 }],
      ['currency', { ...ORDER, currency: 'GHS' }],
      ['reference', { ...ORDER, reference: 'order_99' }],
      ['dropped reference', { amount: ORDER.amount, currency: ORDER.currency }],
    ])(
      'returns 409 when the key is reused with a different %s',
      async (_case, body) => {
        await api.create(acme, 'key-1').expect(202);

        const response = await api.create(acme, 'key-1', body).expect(409);

        expect(response.body).toMatchObject({
          statusCode: 409,
          error: 'Conflict',
          message: expect.stringContaining('different request'),
          requestId: expect.any(String),
        });
        await expect(counts()).resolves.toEqual({
          payments: 1,
          attempts: 1,
          jobs: 1,
        });
      },
    );

    it('scopes keys to the merchant', async () => {
      const a = (await api.create(acme, 'shared-key').expect(202))
        .body as PaymentResponse;
      const b = (await api.create(globex, 'shared-key').expect(202))
        .body as PaymentResponse;

      expect(a.id).not.toBe(b.id);
      await expect(counts()).resolves.toEqual({
        payments: 2,
        attempts: 2,
        jobs: 2,
      });
    });

    it('creates exactly one payment and one job when identical requests race', async () => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => api.create(acme, 'race-key')),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 202,
      ]);
      expect(
        new Set(responses.map((r) => (r.body as PaymentResponse).id)).size,
      ).toBe(1);
      await drainOutbox(app, prisma);
      expect(provider.submissions).toHaveLength(1);
      await expect(counts()).resolves.toEqual({
        payments: 1,
        attempts: 1,
        jobs: 1,
      });
    });

    it('creates exactly one payment when conflicting requests race', async () => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          api.create(acme, 'race-key', {
            ...ORDER,
            amount: i % 2 === 0 ? 1000 : 2000,
          }),
        ),
      );

      expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
      expect(responses.every((r) => [200, 202, 409].includes(r.status))).toBe(
        true,
      );
      await expect(counts()).resolves.toEqual({
        payments: 1,
        attempts: 1,
        jobs: 1,
      });
    });
  });

  describe('reading a payment', () => {
    it('returns the payment to its owner', async () => {
      const created = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;

      await expect(api.read(acme, created.id)).resolves.toEqual(created);
    });

    it("treats another merchant's payment exactly like a missing one", async () => {
      const created = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;

      const foreign = await api.get(globex, created.id).expect(404);
      const missing = await api
        .get(globex, '01890000-0000-7000-8000-000000000000')
        .expect(404);

      expect((foreign.body as ErrorResponse).message).toBe('Payment not found');
      expect((missing.body as ErrorResponse).message).toBe('Payment not found');
    });

    it('validates the id and requires authentication', async () => {
      await api.get(acme, 'not-a-uuid').expect(400);
      await request(app.getHttpServer())
        .get('/v1/payments/01890000-0000-7000-8000-000000000000')
        .expect(401);
    });
  });

  describe('integrity', () => {
    it('never lets a late or duplicate provider result overwrite an outcome', async () => {
      const created = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;
      await drainOutbox(app, prisma);
      const settled = await api.read(acme, created.id);

      await expect(
        app.get(PaymentsService).recordAttemptOutcome(created.attempts[0].id, {
          outcome: 'declined',
          providerReference: 'late',
        }),
      ).resolves.toBe(false);

      await expect(api.read(acme, created.id)).resolves.toEqual(settled);
    });

    it('applies exactly one of two racing outcomes for the same attempt', async () => {
      const created = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;
      const service = app.get(PaymentsService);
      const attemptId = created.attempts[0].id;

      const applied = await Promise.all([
        service.recordAttemptOutcome(attemptId, {
          outcome: 'succeeded',
          providerReference: 'sim_a',
        }),
        service.recordAttemptOutcome(attemptId, {
          outcome: 'declined',
          providerReference: 'sim_b',
        }),
      ]);

      expect(applied.filter(Boolean)).toHaveLength(1);
      await expectConsistentState();
    });

    it('is backed by database constraints, not only application code', async () => {
      const created = (await api.create(acme, 'key-1').expect(202))
        .body as PaymentResponse;
      const fingerprint = '0'.repeat(64);

      await expect(
        prisma.$executeRaw`
          INSERT INTO payments (id, merchant_id, amount, currency, idempotency_key, request_fingerprint, updated_at)
          VALUES (gen_random_uuid(), ${acme.merchantId}::uuid, 100, 'NGN', 'key-1', ${fingerprint}, now())`,
      ).rejects.toThrow(/payments_merchant_id_idempotency_key_key/);
      await expect(
        prisma.$executeRaw`
          INSERT INTO payments (id, merchant_id, amount, currency, idempotency_key, request_fingerprint, updated_at)
          VALUES (gen_random_uuid(), ${acme.merchantId}::uuid, 0, 'NGN', 'key-2', ${fingerprint}, now())`,
      ).rejects.toThrow(/payments_amount_positive/);
      await expect(
        prisma.$executeRaw`
          INSERT INTO payment_attempts (id, payment_id, attempt_number, provider)
          VALUES (gen_random_uuid(), ${created.id}::uuid, 2, 'simulator')`,
      ).rejects.toThrow(/payment_attempts_one_pending_per_payment/);
      await expect(
        prisma.$executeRaw`
          INSERT INTO outbox_jobs (id, type, payment_id, attempt_id, updated_at)
          VALUES (gen_random_uuid(), 'PROCESS_ATTEMPT', ${created.id}::uuid, ${created.attempts[0].id}::uuid, now())`,
      ).rejects.toThrow(/outbox_jobs_attempt_id_type_key/);
      await expect(
        prisma.$executeRaw`UPDATE outbox_jobs SET status = 'PROCESSING'`,
      ).rejects.toThrow(/outbox_jobs_lease_iff_processing/);
    });
  });
});
