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
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import type { RefundResponse } from '../src/refunds/refund.responses.js';
import { runCli } from './support/admin-cli.js';
import {
  drainOutbox,
  makeJobsDue,
  processDueJobsExpecting,
} from './support/outbox.js';
import { ORDER, paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { ownerDatabase, resetDatabase } from './support/test-database.js';

describe('Refunds (PostgreSQL)', () => {
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

  const server = () => app.getHttpServer();

  const refund = (
    merchant: Merchant,
    paymentId: string,
    idempotencyKey: string | undefined,
    body: object = {},
  ) => {
    const req = request(server())
      .post(`/v1/payments/${paymentId}/refunds`)
      .set('Authorization', `Bearer ${merchant.apiKey}`);
    if (idempotencyKey !== undefined)
      req.set('Idempotency-Key', idempotencyKey);
    return req.send(body);
  };

  const readRefund = async (merchant: Merchant, refundId: string) =>
    (
      await request(server())
        .get(`/v1/refunds/${refundId}`)
        .set('Authorization', `Bearer ${merchant.apiKey}`)
        .expect(200)
    ).body as RefundResponse;

  const succeededPayment = async (key = 'pay-1') => {
    const created = (await api.create(acme, key).expect(202))
      .body as PaymentResponse;
    await drainOutbox(app, prisma);
    return api.read(acme, created.id);
  };

  const refundJobs = () =>
    prisma.outboxJob.findMany({
      where: { refundId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { type: 'asc' }],
      select: {
        id: true,
        type: true,
        status: true,
        runCount: true,
        refundId: true,
        attemptId: true,
      },
    });

  describe('creating and processing a refund', () => {
    it('accepts a full refund with 202, queues it without contacting the provider, then refunds the charge', async () => {
      const payment = await succeededPayment();

      const response = await refund(acme, payment.id, 'refund-1').expect(202);
      const accepted = response.body as RefundResponse;

      expect(accepted).toEqual({
        id: expect.any(String),
        paymentId: payment.id,
        amount: ORDER.amount,
        currency: 'NGN',
        status: 'PENDING',
        reference: null,
        providerReference: null,
        failureCode: null,
        createdAt: expect.any(String),
        completedAt: null,
      });
      expect(provider.refundSubmissions).toHaveLength(0);
      await expect(refundJobs()).resolves.toEqual([
        expect.objectContaining({
          type: 'PROCESS_REFUND',
          status: 'QUEUED',
          refundId: accepted.id,
          attemptId: payment.attempts[0].id,
        }),
      ]);

      await drainOutbox(app, prisma);

      await expect(readRefund(acme, accepted.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        providerReference: expect.stringMatching(/^simrf_[0-9a-f]{24}$/),
        completedAt: expect.any(String),
      });
      expect(provider.refundSubmissions).toEqual([
        {
          refundId: accepted.id,
          attemptId: payment.attempts[0].id,
          providerReference: payment.attempts[0].providerReference,
          amount: ORDER.amount,
          currency: 'NGN',
        },
      ]);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        amountRefunded: ORDER.amount,
      });
    });

    it('accepts partial refunds up to the payment amount, and no further', async () => {
      const payment = await succeededPayment();

      await refund(acme, payment.id, 'r1', {
        amount: 200000,
        reference: 'return_1',
      }).expect(202);
      await refund(acme, payment.id, 'r2', { amount: 300000 }).expect(202);
      const over = await refund(acme, payment.id, 'r3', { amount: 1 }).expect(
        409,
      );
      expect((over.body as ErrorResponse).message).toBe(
        'Payment cannot be refunded: nothing_left_to_refund',
      );

      await drainOutbox(app, prisma);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        amountRefunded: 500000,
      });
    });

    it('refuses a refund larger than what is left, counting pending refunds', async () => {
      const payment = await succeededPayment();
      await refund(acme, payment.id, 'r1', { amount: 400000 }).expect(202);

      const response = await refund(acme, payment.id, 'r2', {
        amount: 100001,
      }).expect(409);

      expect((response.body as ErrorResponse).message).toBe(
        'Payment cannot be refunded: amount_exceeds_refundable',
      );
      await expect(prisma.refund.count()).resolves.toBe(1);
    });

    it.each([
      ['pending', null],
      ['failed', SimulatorOutcome.Declined],
    ])('refuses to refund a %s payment', async (_case, outcome) => {
      if (outcome) provider.willReturn(outcome);
      const created = (await api.create(acme, 'pay-1').expect(202))
        .body as PaymentResponse;
      if (outcome) await drainOutbox(app, prisma);

      const response = await refund(acme, created.id, 'r1').expect(409);

      expect((response.body as ErrorResponse).message).toBe(
        'Payment cannot be refunded: payment_not_succeeded',
      );
      await expect(prisma.refund.count()).resolves.toBe(0);
    });

    it('refunds the attempt that succeeded after a retry', async () => {
      provider.willReturn(SimulatorOutcome.Declined);
      const created = (await api.create(acme, 'pay-1').expect(202))
        .body as PaymentResponse;
      await drainOutbox(app, prisma);
      provider.willReturn(SimulatorOutcome.Succeeded);
      await api.retry(acme, created.id, 'retry-1').expect(202);
      await drainOutbox(app, prisma);
      const payment = await api.read(acme, created.id);

      await refund(acme, payment.id, 'r1').expect(202);
      await drainOutbox(app, prisma);

      expect(provider.refundSubmissions).toEqual([
        expect.objectContaining({ attemptId: payment.attempts[1].id }),
      ]);
    });

    it.each([
      [SimulatorOutcome.Declined, 'DECLINED', expect.stringMatching(/^simrf_/)],
      [SimulatorOutcome.Unavailable, 'PROVIDER_UNAVAILABLE', null],
    ])(
      'records a %s refund as FAILED and frees its amount for a new refund',
      async (outcome, failureCode, providerReference) => {
        const payment = await succeededPayment();
        provider.willRefund(outcome);
        const failed = (await refund(acme, payment.id, 'r1').expect(202))
          .body as RefundResponse;
        await drainOutbox(app, prisma);

        await expect(readRefund(acme, failed.id)).resolves.toMatchObject({
          status: 'FAILED',
          failureCode,
          providerReference,
        });
        await expect(api.read(acme, payment.id)).resolves.toMatchObject({
          amountRefunded: 0,
        });

        provider.willRefund(SimulatorOutcome.Succeeded);
        await refund(acme, payment.id, 'r2').expect(202);
        await drainOutbox(app, prisma);
        await expect(api.read(acme, payment.id)).resolves.toMatchObject({
          amountRefunded: ORDER.amount,
        });
      },
    );

    it.each([
      ['a zero amount', { amount: 0 }, ['amount']],
      ['an amount as a string', { amount: '100' }, ['amount']],
      ['a fractional amount', { amount: 1.5 }, ['amount']],
      ['a client-chosen currency', { currency: 'USD' }, ['currency']],
      ['a client-chosen attempt', { attemptId: 'x' }, ['attemptId']],
      ['an invalid reference', { reference: 'two words' }, ['reference']],
    ])('rejects %s', async (_case, body, fields) => {
      const payment = await succeededPayment();

      const response = await refund(acme, payment.id, 'r1', body).expect(400);

      expect(
        (response.body as ErrorResponse).details?.map((d) => d.field),
      ).toEqual(fields);
      await expect(prisma.refund.count()).resolves.toBe(0);
    });

    it('requires an Idempotency-Key and authentication', async () => {
      const payment = await succeededPayment();

      await refund(acme, payment.id, undefined).expect(400);
      await request(server())
        .post(`/v1/payments/${payment.id}/refunds`)
        .send({})
        .expect(401);
      await expect(prisma.refund.count()).resolves.toBe(0);
    });
  });

  describe('idempotency and concurrency', () => {
    it('replays the same request without a second refund or provider call', async () => {
      const payment = await succeededPayment();
      const first = (
        await refund(acme, payment.id, 'r1', { amount: 1000 }).expect(202)
      ).body as RefundResponse;
      await drainOutbox(app, prisma);

      const replay = await refund(acme, payment.id, 'r1', {
        amount: 1000,
      }).expect(200);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toMatchObject({ id: first.id, status: 'SUCCEEDED' });
      await drainOutbox(app, prisma);
      expect(provider.refundSubmissions).toHaveLength(1);
      await expect(prisma.refund.count()).resolves.toBe(1);
    });

    it.each([
      ['a different amount', { amount: 1001 }],
      ['a full refund instead of a partial one', {}],
      ['a different reference', { amount: 1000, reference: 'other' }],
    ])('returns 409 when the key is reused with %s', async (_case, body) => {
      const payment = await succeededPayment();
      await refund(acme, payment.id, 'r1', { amount: 1000 }).expect(202);

      const response = await refund(acme, payment.id, 'r1', body).expect(409);

      expect((response.body as ErrorResponse).message).toContain(
        'different request',
      );
      await expect(prisma.refund.count()).resolves.toBe(1);
    });

    it('returns 409 when the key is reused for another payment', async () => {
      const first = await succeededPayment('pay-1');
      const second = await succeededPayment('pay-2');
      await refund(acme, first.id, 'r1').expect(202);

      await refund(acme, second.id, 'r1').expect(409);
      await expect(prisma.refund.count()).resolves.toBe(1);
    });

    it('creates exactly one refund when identical requests race', async () => {
      const payment = await succeededPayment();

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          refund(acme, payment.id, 'race', { amount: 1000 }),
        ),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 202,
      ]);
      expect(
        new Set(responses.map((r) => (r.body as RefundResponse).id)).size,
      ).toBe(1);
      await expect(prisma.refund.count()).resolves.toBe(1);
    });

    it('never refunds more than the payment when different refunds race for the remainder', async () => {
      const payment = await succeededPayment();

      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          refund(acme, payment.id, `race-${i}`, { amount: 200000 }),
        ),
      );

      expect(responses.filter((r) => r.status === 202)).toHaveLength(2);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(4);
      const [{ total }] = await prisma.$queryRaw<{ total: bigint }[]>`
        SELECT coalesce(sum(amount), 0)::bigint AS total FROM refunds`;
      expect(total).toBe(400000n);
    });

    it('scopes keys and payments to the merchant', async () => {
      const payment = await succeededPayment();

      const foreign = await refund(globex, payment.id, 'r1').expect(404);
      expect((foreign.body as ErrorResponse).message).toBe('Payment not found');
      await refund(acme, '01890000-0000-7000-8000-000000000000', 'r1').expect(
        404,
      );
      await refund(acme, payment.id, 'r1').expect(202);
      await expect(prisma.refund.count()).resolves.toBe(1);
    });
  });

  describe('reading refunds', () => {
    it("lists a payment's refunds oldest first and reads one, only for its owner", async () => {
      const payment = await succeededPayment();
      const a = (
        await refund(acme, payment.id, 'r1', { amount: 100 }).expect(202)
      ).body as RefundResponse;
      const b = (
        await refund(acme, payment.id, 'r2', { amount: 200 }).expect(202)
      ).body as RefundResponse;
      await ownerDatabase().$executeRaw`
        UPDATE refunds SET created_at = created_at - interval '1 minute'
        WHERE id = ${a.id}::uuid`;

      const listed = await request(server())
        .get(`/v1/payments/${payment.id}/refunds`)
        .set('Authorization', `Bearer ${acme.apiKey}`)
        .expect(200);
      expect((listed.body as RefundResponse[]).map((r) => r.id)).toEqual([
        a.id,
        b.id,
      ]);
      await expect(readRefund(acme, b.id)).resolves.toMatchObject({
        amount: 200,
      });

      await request(server())
        .get(`/v1/payments/${payment.id}/refunds`)
        .set('Authorization', `Bearer ${globex.apiKey}`)
        .expect(404);
      const foreign = await request(server())
        .get(`/v1/refunds/${a.id}`)
        .set('Authorization', `Bearer ${globex.apiKey}`)
        .expect(404);
      expect((foreign.body as ErrorResponse).message).toBe('Refund not found');
    });
  });

  describe('unknown outcomes and reconciliation', () => {
    it('resolves a refund whose answer was lost by looking it up, without submitting it again', async () => {
      const payment = await succeededPayment();
      provider.willRefundThenTimeOut(SimulatorOutcome.Succeeded);
      const created = (await refund(acme, payment.id, 'r1').expect(202))
        .body as RefundResponse;

      await processDueJobsExpecting(app, prisma, 1);

      await expect(readRefund(acme, created.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      await expect(refundJobs()).resolves.toEqual([
        expect.objectContaining({
          type: 'PROCESS_REFUND',
          status: 'COMPLETED',
        }),
        expect.objectContaining({ type: 'RECONCILE_REFUND', status: 'QUEUED' }),
      ]);

      await drainOutbox(app, prisma);

      await expect(readRefund(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      expect(provider.refundSubmissions).toHaveLength(1);
      expect(provider.refundLookups).toEqual([{ refundId: created.id }]);
    });

    it('resubmits under the same refund ID only when the provider has no record of it', async () => {
      const payment = await succeededPayment();
      provider.willThrowOnRefund(new Error('connection reset before sending'));
      const created = (await refund(acme, payment.id, 'r1').expect(202))
        .body as RefundResponse;
      await processDueJobsExpecting(app, prisma, 1);

      provider.willRefund(SimulatorOutcome.Succeeded);
      await drainOutbox(app, prisma);

      expect(provider.refundSubmissions.map((s) => s.refundId)).toEqual([
        created.id,
        created.id,
      ]);
      await expect(readRefund(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      const resolutions = await prisma.paymentEvent.count({
        where: { refundId: created.id, type: 'refund.resolved' },
      });
      expect(resolutions).toBe(1);
    });

    it('looks up instead of resubmitting a refund that may already have been sent', async () => {
      const payment = await succeededPayment();
      const created = (await refund(acme, payment.id, 'r1').expect(202))
        .body as RefundResponse;
      await prisma.refund.update({
        where: { id: created.id },
        data: { submittedAt: new Date() },
      });
      provider.refundLedger.set(created.id, {
        outcome: 'succeeded',
        providerReference: 'simrf_already_processed',
      });

      await drainOutbox(app, prisma);

      expect(provider.refundSubmissions).toHaveLength(0);
      await expect(readRefund(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        providerReference: 'simrf_already_processed',
      });
    });

    it('leaves a refund PENDING and flagged for an operator once lookups give up, then resolves it after a requeue', async () => {
      const payment = await succeededPayment();
      provider.willRefundThenTimeOut(SimulatorOutcome.Succeeded);
      const created = (await refund(acme, payment.id, 'r1').expect(202))
        .body as RefundResponse;
      provider.willLookupRefund(
        ...Array.from({ length: 10 }, () => ({
          status: 'processing' as const,
        })),
      );

      await drainOutbox(app, prisma);

      await expect(readRefund(acme, created.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      const lookup = (await refundJobs()).find(
        (job) => job.type === 'RECONCILE_REFUND',
      )!;
      expect(lookup).toMatchObject({ status: 'DEAD', runCount: 10 });

      const unresolved = await runCli(app, 'payments:unresolved');
      expect(unresolved.out).toContain('Unresolved refunds, oldest first');
      expect(unresolved.out).toContain(`refund=${created.id}`);
      expect(unresolved.out).toContain('state=reconciliation_exhausted');
      const status = await runCli(app, 'ops:status');
      expect(status.out).toMatch(/Refunds awaiting an operator:\s+1/);

      await expect(
        runCli(app, 'outbox:requeue', '--job', lookup.id),
      ).resolves.toMatchObject({ code: 0 });
      await drainOutbox(app, prisma);

      await expect(readRefund(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      const history = await prisma.paymentEvent.findMany({
        where: { refundId: created.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true, source: true },
      });
      expect(history.map((event) => event.type)).toEqual([
        'refund.created',
        'refund.submitted',
        'refund.outcome_unknown',
        ...Array.from({ length: 9 }, () => 'reconciliation.deferred'),
        'outbox_job.dead',
        'outbox_job.requeued',
        'refund.resolved',
      ]);
    });

    it('queues a lookup for a pending refund left without live work', async () => {
      const payment = await succeededPayment();
      const created = (await refund(acme, payment.id, 'r1').expect(202))
        .body as RefundResponse;
      await ownerDatabase().$executeRaw`
        UPDATE outbox_jobs SET status = 'COMPLETED', completed_at = now()
        WHERE refund_id = ${created.id}::uuid`;
      await ownerDatabase().$executeRaw`
        UPDATE refunds SET created_at = created_at - interval '1 hour'`;

      await expect(app.get(OutboxWorker).sweepStaleAttempts()).resolves.toBe(1);
      await expect(app.get(OutboxWorker).sweepStaleAttempts()).resolves.toBe(0);

      await makeJobsDue(prisma);
      await drainOutbox(app, prisma);
      await expect(readRefund(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      await expect(
        prisma.paymentEvent.count({
          where: { refundId: created.id, type: 'reconciliation.scheduled' },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('history and operator tooling', () => {
    it("records the refund in the payment's history and shows it in payment:inspect", async () => {
      const payment = await succeededPayment();
      const created = (
        await refund(acme, payment.id, 'r1', {
          amount: 1500,
        }).expect(202)
      ).body as RefundResponse;
      await drainOutbox(app, prisma);

      const history = await prisma.paymentEvent.findMany({
        where: { refundId: created.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          type: true,
          source: true,
          attemptId: true,
          paymentStatusBefore: true,
          paymentStatusAfter: true,
          details: true,
        },
      });
      expect(history).toEqual([
        expect.objectContaining({
          type: 'refund.created',
          source: 'MERCHANT',
          attemptId: payment.attempts[0].id,
          details: { refundStatusAfter: 'PENDING', fullRefund: false },
        }),
        expect.objectContaining({ type: 'refund.submitted', source: 'WORKER' }),
        expect.objectContaining({
          type: 'refund.resolved',
          source: 'PROVIDER_RESPONSE',
          paymentStatusBefore: null,
          paymentStatusAfter: null,
          details: expect.objectContaining({
            refundStatusBefore: 'PENDING',
            refundStatusAfter: 'SUCCEEDED',
          }),
        }),
      ]);
      for (const event of history) {
        expect(event.details).not.toHaveProperty('amount');
      }

      const inspect = await runCli(
        app,
        'payment:inspect',
        '--payment',
        payment.id,
      );
      expect(inspect.code).toBe(0);
      expect(inspect.out).toContain(
        `R1 ${created.id}  SUCCEEDED  1500 NGN  of attempt #1`,
      );
      expect(inspect.out).toMatch(/refund\.resolved\s+attempt #1\s+refund R1/);
      expect(inspect.out).toContain('PROCESS_REFUND COMPLETED');
    });

    it('reports refunds in ops:status and ops:metrics', async () => {
      const payment = await succeededPayment();
      await refund(acme, payment.id, 'r1', { amount: 100 }).expect(202);
      await drainOutbox(app, prisma);
      await refund(acme, payment.id, 'r2', { amount: 100 }).expect(202);

      const metrics = await runCli(app, 'ops:metrics');
      expect(metrics.out).toContain(
        'payguard_refunds{status="SUCCEEDED",failure_code="none"} 1',
      );
      expect(metrics.out).toContain('payguard_refunds_unresolved 1');
      const status = await runCli(app, 'ops:status');
      expect(status.out).toMatch(/Unresolved refunds:\s+1/);
    });

    it('keeps the completed jobs of a pending refund when pruning', async () => {
      const payment = await succeededPayment();
      provider.willRefundThenTimeOut(SimulatorOutcome.Succeeded);
      await refund(acme, payment.id, 'r1').expect(202);
      await processDueJobsExpecting(app, prisma, 1);
      await ownerDatabase().$executeRaw`
        UPDATE outbox_jobs SET completed_at = now() - interval '60 days'
        WHERE status = 'COMPLETED'`;

      await runCli(app, 'maintenance:prune', '--completed-jobs-days', '30');

      await expect(refundJobs()).resolves.toEqual([
        expect.objectContaining({
          type: 'PROCESS_REFUND',
          status: 'COMPLETED',
        }),
        expect.objectContaining({ type: 'RECONCILE_REFUND', status: 'QUEUED' }),
      ]);
    });
  });

  describe('database guarantees', () => {
    const insertRefund = (
      paymentId: string,
      attemptId: string,
      amount: number,
      merchantId = acme.merchantId,
      currency = 'NGN',
    ) => prisma.$executeRaw`
      INSERT INTO refunds (id, merchant_id, payment_id, attempt_id, amount, currency,
                           idempotency_key, request_fingerprint, updated_at)
      VALUES (gen_random_uuid(), ${merchantId}::uuid, ${paymentId}::uuid, ${attemptId}::uuid,
              ${amount}, ${currency}, gen_random_uuid()::text, ${'0'.repeat(64)}, now())`;

    it('refuses refunds beyond the payment amount, whatever the caller', async () => {
      const payment = await succeededPayment();
      const attemptId = payment.attempts[0].id;

      await insertRefund(payment.id, attemptId, 400000);
      await expect(insertRefund(payment.id, attemptId, 100001)).rejects.toThrow(
        /refunds_within_payment_amount|exceed the payment amount/,
      );
      await insertRefund(payment.id, attemptId, 100000);
    });

    it('refuses refunds that do not match a succeeded charge of the payment', async () => {
      const payment = await succeededPayment();
      const pending = (await api.create(acme, 'pay-2').expect(202))
        .body as PaymentResponse;

      await expect(
        insertRefund(pending.id, pending.attempts[0].id, 1),
      ).rejects.toThrow(/succeeded charge/);
      await expect(
        insertRefund(payment.id, payment.attempts[0].id, 1, globex.merchantId),
      ).rejects.toThrow(/succeeded charge/);
      await expect(
        insertRefund(
          payment.id,
          payment.attempts[0].id,
          1,
          acme.merchantId,
          'USD',
        ),
      ).rejects.toThrow(/succeeded charge/);
      await expect(
        insertRefund(payment.id, pending.attempts[0].id, 1),
      ).rejects.toThrow(/succeeded charge/);
    });

    it('keeps refund jobs tied to a refund and unique per refund', async () => {
      const payment = await succeededPayment();
      const created = (await refund(acme, payment.id, 'r1').expect(202))
        .body as RefundResponse;

      await expect(
        prisma.$executeRaw`
          INSERT INTO outbox_jobs (id, type, payment_id, attempt_id, updated_at)
          VALUES (gen_random_uuid(), 'PROCESS_REFUND', ${payment.id}::uuid,
                  ${payment.attempts[0].id}::uuid, now())`,
      ).rejects.toThrow(/outbox_jobs_refund_iff_refund_job/);
      await expect(
        prisma.$executeRaw`
          INSERT INTO outbox_jobs (id, type, payment_id, attempt_id, refund_id, updated_at)
          VALUES (gen_random_uuid(), 'PROCESS_REFUND', ${payment.id}::uuid,
                  ${payment.attempts[0].id}::uuid, ${created.id}::uuid, now())`,
      ).rejects.toThrow(/outbox_jobs_refund_id_type_key/);
      await expect(
        prisma.refund.update({
          where: { id: created.id },
          data: { amount: 1n },
        }),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
