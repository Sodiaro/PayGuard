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
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';

type Merchant = Awaited<ReturnType<typeof provisionMerchant>>;

const ORDER = { amount: 500000, currency: 'NGN', reference: 'order_10042' };

describe('Payments API (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let acme: Merchant;
  let globex: Merchant;

  beforeAll(async () => {
    app = await createTestApp({ provider });
    prisma = prismaOf(app);
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

  const create = (
    merchant: Merchant,
    idempotencyKey: string | undefined,
    body: unknown = ORDER,
  ) => {
    const req = request(app.getHttpServer())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${merchant.apiKey}`);
    if (idempotencyKey !== undefined)
      req.set('Idempotency-Key', idempotencyKey);
    return req.send(body as object);
  };
  const get = (merchant: Merchant, id: string) =>
    request(app.getHttpServer())
      .get(`/v1/payments/${id}`)
      .set('Authorization', `Bearer ${merchant.apiKey}`);

  const counts = async () => ({
    payments: await prisma.payment.count(),
    attempts: await prisma.paymentAttempt.count(),
  });

  // With one attempt per payment, the attempt and its payment must always agree.
  const expectConsistentState = async () => {
    const rows = await prisma.$queryRaw<{ payment: string; attempt: string }[]>`
      SELECT p.status::text AS payment, a.status::text AS attempt
      FROM payments p JOIN payment_attempts a ON a.payment_id = p.id`;
    for (const row of rows) expect(row.attempt).toBe(row.payment);
  };

  describe('creating a payment', () => {
    it('processes it synchronously and returns 201 with the outcome', async () => {
      const response = await create(acme, 'key-1').expect(201);
      const payment = response.body as PaymentResponse;

      expect(payment).toEqual({
        id: expect.any(String),
        amount: 500000,
        currency: 'NGN',
        status: 'SUCCEEDED',
        reference: 'order_10042',
        failureCode: null,
        attempts: [
          {
            id: expect.any(String),
            attemptNumber: 1,
            provider: 'simulator',
            status: 'SUCCEEDED',
            providerReference: expect.stringMatching(/^sim_[0-9a-f]{24}$/),
            failureCode: null,
            createdAt: expect.any(String),
            completedAt: expect.any(String),
          },
        ],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(response.headers).not.toHaveProperty('idempotent-replayed');
      expect(response.headers['x-request-id']).toBeTruthy();

      expect(provider.calls).toEqual([
        {
          attemptId: payment.attempts[0].id,
          merchantId: acme.merchantId,
          amount: 500000,
          currency: 'NGN',
        },
      ]);
      await expectConsistentState();
    });

    it('stores amounts as exact integers in every currency exponent', async () => {
      for (const [key, body] of [
        ['jpy', { amount: 500, currency: 'JPY' }],
        ['kwd', { amount: 1500, currency: 'KWD' }],
        ['max', { amount: MAX_PAYMENT_AMOUNT, currency: 'USD' }],
      ] as const) {
        const response = await create(acme, key, body).expect(201);
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
      const response = await create(acme, key).expect(400);
      const body = response.body as ErrorResponse;

      expect(body).toMatchObject({
        statusCode: 400,
        message: 'Validation failed',
        path: '/v1/payments',
      });
      expect(body.details).toEqual([
        {
          field: 'Idempotency-Key',
          messages: [expect.stringContaining(message)],
        },
      ]);
      await expect(counts()).resolves.toEqual({ payments: 0, attempts: 0 });
      expect(provider.calls).toHaveLength(0);
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
      const response = await create(acme, 'key-invalid', body).expect(400);

      expect(
        (response.body as ErrorResponse).details?.map((d) => d.field),
      ).toEqual(fields);
      await expect(counts()).resolves.toEqual({ payments: 0, attempts: 0 });
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
      await expect(counts()).resolves.toEqual({ payments: 0, attempts: 0 });
    });
  });

  describe('simulator outcomes', () => {
    it('records a decline as FAILED/DECLINED with the provider reference', async () => {
      provider.willReturn(SimulatorOutcome.Declined);

      const payment = (await create(acme, 'key-1').expect(201))
        .body as PaymentResponse;

      expect(payment).toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
      });
      expect(payment.attempts[0]).toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
        providerReference: expect.stringMatching(/^sim_/),
        completedAt: expect.any(String),
      });
      await expectConsistentState();
    });

    it('records an outage as PROVIDER_UNAVAILABLE, never as a decline', async () => {
      provider.willReturn(SimulatorOutcome.Unavailable);

      const payment = (await create(acme, 'key-1').expect(201))
        .body as PaymentResponse;

      expect(payment).toMatchObject({
        status: 'FAILED',
        failureCode: 'PROVIDER_UNAVAILABLE',
      });
      expect(payment.attempts[0]).toMatchObject({
        status: 'FAILED',
        failureCode: 'PROVIDER_UNAVAILABLE',
        providerReference: null,
      });
      await expectConsistentState();
    });

    it.each([
      [
        'throws',
        () =>
          provider.willThrow(
            new Error('gateway said: card 4111111111111111 cvv 123 rejected'),
          ),
      ],
      [
        'returns an unrecognised outcome',
        () => provider.willAnswer({ outcome: 'maybe', raw: 'cvv=123' }),
      ],
    ])(
      'leaves the outcome PENDING when the provider %s, without leaking details',
      async (_case, arrange) => {
        arrange();

        const response = await create(acme, 'key-1').expect(201);
        const payment = response.body as PaymentResponse;

        expect(payment).toMatchObject({ status: 'PENDING', failureCode: null });
        expect(payment.attempts[0]).toMatchObject({
          status: 'PENDING',
          failureCode: null,
          providerReference: null,
          completedAt: null,
        });
        expect(response.text).not.toMatch(/4111|cvv|gateway|maybe/);
        await expectConsistentState();
      },
    );
  });

  describe('idempotency', () => {
    it('replays the same request without a second payment or provider call', async () => {
      const first = (await create(acme, 'key-1').expect(201))
        .body as PaymentResponse;

      const replay = await create(acme, 'key-1', {
        reference: 'order_10042',
        currency: 'NGN',
        amount: 500000,
      }).expect(200);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first);
      expect(provider.calls).toHaveLength(1);
      await expect(counts()).resolves.toEqual({ payments: 1, attempts: 1 });
    });

    it('does not retry a failed payment on replay', async () => {
      provider.willReturn(SimulatorOutcome.Unavailable);
      await create(acme, 'key-1').expect(201);
      provider.willReturn(SimulatorOutcome.Succeeded);

      const replay = await create(acme, 'key-1').expect(200);

      expect((replay.body as PaymentResponse).status).toBe('FAILED');
      expect(provider.calls).toHaveLength(1);
    });

    it.each([
      ['amount', { ...ORDER, amount: 500001 }],
      ['currency', { ...ORDER, currency: 'GHS' }],
      ['reference', { ...ORDER, reference: 'order_99' }],
      ['dropped reference', { amount: ORDER.amount, currency: ORDER.currency }],
    ])(
      'returns 409 when the key is reused with a different %s',
      async (_case, body) => {
        await create(acme, 'key-1').expect(201);

        const response = await create(acme, 'key-1', body).expect(409);

        expect(response.body).toMatchObject({
          statusCode: 409,
          error: 'Conflict',
          message: expect.stringContaining('different request'),
          requestId: expect.any(String),
        });
        expect(provider.calls).toHaveLength(1);
        await expect(counts()).resolves.toEqual({ payments: 1, attempts: 1 });
      },
    );

    it('scopes keys to the merchant', async () => {
      const a = (await create(acme, 'shared-key').expect(201))
        .body as PaymentResponse;
      const b = (await create(globex, 'shared-key').expect(201))
        .body as PaymentResponse;

      expect(a.id).not.toBe(b.id);
      expect(provider.calls.map((call) => call.merchantId)).toEqual([
        acme.merchantId,
        globex.merchantId,
      ]);
    });

    it('creates exactly one payment when identical requests race', async () => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => create(acme, 'race-key')),
      );

      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      expect(
        new Set(responses.map((r) => (r.body as PaymentResponse).id)).size,
      ).toBe(1);
      expect(provider.calls).toHaveLength(1);
      await expect(counts()).resolves.toEqual({ payments: 1, attempts: 1 });
    });

    it('creates exactly one payment when conflicting requests race', async () => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          create(acme, 'race-key', {
            ...ORDER,
            amount: i % 2 === 0 ? 1000 : 2000,
          }),
        ),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.every((r) => [200, 201, 409].includes(r.status))).toBe(
        true,
      );
      expect(provider.calls).toHaveLength(1);
      await expect(counts()).resolves.toEqual({ payments: 1, attempts: 1 });
    });

    it('answers a replay that arrives mid-processing with the PENDING payment', async () => {
      const gate = provider.hold();
      const original = create(acme, 'key-1').then((response) => response);
      await gate.entered;

      const replay = await create(acme, 'key-1').expect(200);
      expect((replay.body as PaymentResponse).status).toBe('PENDING');
      expect((replay.body as PaymentResponse).attempts[0].status).toBe(
        'PENDING',
      );

      gate.release();
      const finished = await original;
      expect(finished.status).toBe(201);
      expect((finished.body as PaymentResponse).status).toBe('SUCCEEDED');
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('reading a payment', () => {
    it('returns the payment to its owner', async () => {
      const created = (await create(acme, 'key-1').expect(201))
        .body as PaymentResponse;

      const response = await get(acme, created.id).expect(200);

      expect(response.body).toEqual(created);
    });

    it("treats another merchant's payment exactly like a missing one", async () => {
      const created = (await create(acme, 'key-1').expect(201))
        .body as PaymentResponse;

      const foreign = await get(globex, created.id).expect(404);
      const missing = await get(
        globex,
        '01890000-0000-7000-8000-000000000000',
      ).expect(404);

      expect((foreign.body as ErrorResponse).message).toBe('Payment not found');
      expect((missing.body as ErrorResponse).message).toBe('Payment not found');
    });

    it('validates the id and requires authentication', async () => {
      await get(acme, 'not-a-uuid').expect(400);
      await request(app.getHttpServer())
        .get('/v1/payments/01890000-0000-7000-8000-000000000000')
        .expect(401);
    });
  });

  describe('integrity', () => {
    it('never lets a late or duplicate provider result overwrite an outcome', async () => {
      const payment = (await create(acme, 'key-1').expect(201))
        .body as PaymentResponse;
      const service = app.get(PaymentsService);

      await expect(
        service.recordAttemptOutcome(payment.attempts[0].id, {
          outcome: 'declined',
          providerReference: 'late',
        }),
      ).resolves.toBe(false);

      const after = (await get(acme, payment.id).expect(200))
        .body as PaymentResponse;
      expect(after.status).toBe('SUCCEEDED');
      expect(after.attempts[0].providerReference).toBe(
        payment.attempts[0].providerReference,
      );
    });

    it('resolves a PENDING attempt once, through the same guarded path', async () => {
      provider.willThrow(new Error('timeout'));
      const payment = (await create(acme, 'key-1').expect(201))
        .body as PaymentResponse;
      const service = app.get(PaymentsService);
      const attemptId = payment.attempts[0].id;

      await expect(
        service.recordAttemptOutcome(attemptId, {
          outcome: 'succeeded',
          providerReference: 'sim_recovered',
        }),
      ).resolves.toBe(true);
      await expect(
        service.recordAttemptOutcome(attemptId, { outcome: 'unavailable' }),
      ).resolves.toBe(false);

      const after = (await get(acme, payment.id).expect(200))
        .body as PaymentResponse;
      expect(after).toMatchObject({
        status: 'SUCCEEDED',
        attempts: [{ status: 'SUCCEEDED' }],
      });
      await expectConsistentState();
    });

    it('is backed by database constraints, not only application code', async () => {
      const payment = (await create(acme, 'key-1').expect(201))
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
          UPDATE payment_attempts SET status = 'PENDING' WHERE id = ${payment.attempts[0].id}::uuid`,
      ).rejects.toThrow(/payment_attempts_completed_iff_terminal/);

      provider.willThrow(new Error('unknown'));
      const pending = (await create(acme, 'key-3').expect(201))
        .body as PaymentResponse;
      await expect(
        prisma.$executeRaw`
          INSERT INTO payment_attempts (id, payment_id, attempt_number, provider)
          VALUES (gen_random_uuid(), ${pending.id}::uuid, 2, 'simulator')`,
      ).rejects.toThrow(/payment_attempts_one_pending_per_payment/);
    });
  });
});
