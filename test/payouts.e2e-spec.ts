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
import type {
  MerchantEventListResponse,
  WebhookEndpointResponse,
} from '../src/merchant-webhooks/merchant-webhook.responses.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import type {
  BalanceResponse,
  PayoutListResponse,
  PayoutResponse,
} from '../src/payouts/payout.responses.js';
import { runCli } from './support/admin-cli.js';
import {
  drainOutbox,
  makeJobsDue,
  processDueJobsExpecting,
} from './support/outbox.js';
import { paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { ownerDatabase, resetDatabase } from './support/test-database.js';
import {
  startWebhookReceiver,
  verifiesWith,
} from './support/webhook-receiver.js';

const DESTINATION = {
  bankCode: '058',
  accountNumber: '0123456789',
  accountName: 'Test Merchant Ltd',
};

describe('Balance and payouts (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let api: ReturnType<typeof paymentsApi>;
  let receiver: Awaited<ReturnType<typeof startWebhookReceiver>>;
  let acme: Merchant;
  let globex: Merchant;

  beforeAll(async () => {
    app = await createTestApp({ provider });
    prisma = prismaOf(app);
    api = paymentsApi(app);
    receiver = await startWebhookReceiver();
  });

  beforeEach(async () => {
    await resetDatabase();
    provider.reset();
    receiver.reset();
    acme = await provisionMerchant(app, 'acme');
    globex = await provisionMerchant(app, 'globex');
  });

  afterAll(async () => {
    await receiver.close();
    await app.close();
  });

  const server = () => app.getHttpServer();
  const auth = (req: request.Test, merchant: Merchant) =>
    req.set('Authorization', `Bearer ${merchant.apiKey}`);

  const payout = (
    merchant: Merchant,
    idempotencyKey: string | undefined,
    body: object,
  ) => {
    const req = auth(request(server()).post('/v1/payouts'), merchant);
    if (idempotencyKey !== undefined) {
      req.set('Idempotency-Key', idempotencyKey);
    }
    return req.send(body);
  };

  const payoutOf = (amount: number, extra: object = {}) => ({
    amount,
    currency: 'NGN',
    destination: DESTINATION,
    ...extra,
  });

  const readPayout = async (merchant: Merchant, payoutId: string) =>
    (
      await auth(request(server()).get(`/v1/payouts/${payoutId}`), merchant)
        .send()
        .expect(200)
    ).body as PayoutResponse;

  const balanceOf = async (merchant: Merchant) =>
    (
      (
        await auth(request(server()).get('/v1/balance'), merchant)
          .send()
          .expect(200)
      ).body as BalanceResponse
    ).balances;

  const listPayouts = async (
    merchant: Merchant,
    query: Record<string, string | number> = {},
  ) =>
    (
      await auth(request(server()).get('/v1/payouts').query(query), merchant)
        .send()
        .expect(200)
    ).body as PayoutListResponse;

  // A succeeded payment adds what it captured to the merchant's balance.
  const fund = async (
    key = 'pay-1',
    body: object = { amount: 500000, currency: 'NGN' },
    merchant: Merchant = acme,
  ) => {
    const created = (await api.create(merchant, key, body).expect(202))
      .body as PaymentResponse;
    await drainOutbox(app, prisma);
    return api.read(merchant, created.id);
  };

  const refund = (paymentId: string, key: string, body: object = {}) =>
    auth(request(server()).post(`/v1/payments/${paymentId}/refunds`), acme)
      .set('Idempotency-Key', key)
      .send(body);

  const payoutJobs = () =>
    prisma.outboxJob.findMany({
      where: { payoutId: { not: null }, merchantEventId: null },
      orderBy: [{ createdAt: 'asc' }, { type: 'asc' }],
      select: {
        id: true,
        type: true,
        status: true,
        runCount: true,
        paymentId: true,
        attemptId: true,
        payoutId: true,
      },
    });

  const historyOf = (payoutId: string) =>
    prisma.payoutEvent.findMany({
      where: { payoutId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        type: true,
        source: true,
        statusBefore: true,
        statusAfter: true,
        details: true,
      },
    });

  describe('the balance', () => {
    it('is empty for a merchant without activity', async () => {
      await expect(balanceOf(acme)).resolves.toEqual([]);
    });

    it('counts what succeeded payments captured, per currency, less refunds', async () => {
      const first = await fund('pay-1');
      const manual = await fund('pay-2', {
        amount: 500000,
        currency: 'NGN',
        captureMethod: 'MANUAL',
      });
      await auth(
        request(server()).post(`/v1/payments/${manual.id}/capture`),
        acme,
      )
        .set('Idempotency-Key', 'capture-1')
        .send({ amount: 300000 })
        .expect(202);
      await drainOutbox(app, prisma);
      provider.willReturn(SimulatorOutcome.Declined);
      await fund('pay-3');
      provider.willReturn(SimulatorOutcome.Succeeded);
      await fund('pay-4', { amount: 1000, currency: 'USD' });
      await api.create(acme, 'pay-5').expect(202);
      await refund(first.id, 'refund-1', { amount: 100000 }).expect(202);

      await expect(balanceOf(acme)).resolves.toEqual([
        {
          currency: 'NGN',
          available: 700000,
          captured: 800000,
          refunded: 100000,
          paidOut: 0,
          inTransit: 0,
        },
        {
          currency: 'USD',
          available: 1000,
          captured: 1000,
          refunded: 0,
          paidOut: 0,
          inTransit: 0,
        },
      ]);
      await expect(balanceOf(globex)).resolves.toEqual([]);
    });
  });

  describe('creating and processing a payout', () => {
    it('accepts a payout with 202, takes it out of the balance at once, then sends it', async () => {
      await fund();

      const response = await payout(
        acme,
        'payout-1',
        payoutOf(200000, { reference: 'settlement_1' }),
      ).expect(202);
      const accepted = response.body as PayoutResponse;

      expect(accepted).toEqual({
        id: expect.any(String),
        amount: 200000,
        currency: 'NGN',
        status: 'PENDING',
        destination: {
          bankCode: '058',
          accountNumberLast4: '6789',
          accountName: 'Test Merchant Ltd',
        },
        reference: 'settlement_1',
        providerReference: null,
        failureCode: null,
        createdAt: expect.any(String),
        completedAt: null,
      });
      expect(JSON.stringify(response.body)).not.toContain('0123456789');
      expect(provider.payoutSubmissions).toHaveLength(0);
      await expect(payoutJobs()).resolves.toEqual([
        expect.objectContaining({
          type: 'PROCESS_PAYOUT',
          status: 'QUEUED',
          payoutId: accepted.id,
          paymentId: null,
          attemptId: null,
        }),
      ]);
      await expect(balanceOf(acme)).resolves.toEqual([
        expect.objectContaining({ available: 300000, inTransit: 200000 }),
      ]);

      await drainOutbox(app, prisma);

      await expect(readPayout(acme, accepted.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        providerReference: expect.stringMatching(/^simpo_[0-9a-f]{24}$/),
        completedAt: expect.any(String),
      });
      expect(provider.payoutSubmissions).toEqual([
        {
          payoutId: accepted.id,
          merchantId: acme.merchantId,
          amount: 200000,
          currency: 'NGN',
          destination: DESTINATION,
        },
      ]);
      await expect(balanceOf(acme)).resolves.toEqual([
        expect.objectContaining({
          available: 300000,
          paidOut: 200000,
          inTransit: 0,
        }),
      ]);
    });

    it('refuses a payout above the available balance, counting pending payouts', async () => {
      await fund();
      await payout(acme, 'payout-1', payoutOf(400000)).expect(202);

      const over = await payout(acme, 'payout-2', payoutOf(100001)).expect(409);

      expect((over.body as ErrorResponse).message).toBe(
        'Payout exceeds the available balance: 100000 NGN available',
      );
      const other = await payout(acme, 'payout-3', {
        ...payoutOf(1),
        currency: 'USD',
      }).expect(409);
      expect((other.body as ErrorResponse).message).toBe(
        'Payout exceeds the available balance: 0 USD available',
      );
      await payout(acme, 'payout-4', payoutOf(100000)).expect(202);
      await expect(prisma.payout.count()).resolves.toBe(2);
    });

    it('returns a failed payout to the available balance', async () => {
      await fund();
      provider.willPayOut(SimulatorOutcome.Declined);
      const created = (
        await payout(acme, 'payout-1', payoutOf(500000)).expect(202)
      ).body as PayoutResponse;

      await drainOutbox(app, prisma);

      await expect(readPayout(acme, created.id)).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
        providerReference: expect.stringMatching(/^simpo_/),
      });
      await expect(balanceOf(acme)).resolves.toEqual([
        expect.objectContaining({ available: 500000, paidOut: 0 }),
      ]);
      provider.willPayOut(SimulatorOutcome.Succeeded);
      await payout(acme, 'payout-2', payoutOf(500000)).expect(202);
    });

    it('lets refunds take the balance below zero, and refuses payouts until it recovers', async () => {
      const payment = await fund();
      await payout(acme, 'payout-1', payoutOf(500000)).expect(202);
      await drainOutbox(app, prisma);

      await refund(payment.id, 'refund-1', { amount: 200000 }).expect(202);

      await expect(balanceOf(acme)).resolves.toEqual([
        expect.objectContaining({ available: -200000 }),
      ]);
      const refused = await payout(acme, 'payout-2', payoutOf(1)).expect(409);
      expect((refused.body as ErrorResponse).message).toBe(
        'Payout exceeds the available balance: -200000 NGN available',
      );
      await fund('pay-2');
      await payout(acme, 'payout-3', payoutOf(300000)).expect(202);
    });

    it.each([
      [
        'no destination',
        { amount: 1000, currency: 'NGN' },
        'destination should not be null or undefined',
      ],
      [
        'a list of destinations',
        payoutOf(1000, { destination: [DESTINATION] }),
        'destination must be an object',
      ],
      [
        'an account number with spaces',
        payoutOf(1000, {
          destination: { ...DESTINATION, accountNumber: '0123 456789' },
        }),
        'accountNumber must be',
      ],
      [
        'a lowercase bank code',
        payoutOf(1000, { destination: { ...DESTINATION, bankCode: 'gtb' } }),
        'bankCode must be',
      ],
      [
        'a blank account name',
        payoutOf(1000, { destination: { ...DESTINATION, accountName: '  ' } }),
        'accountName must be',
      ],
      ['a zero amount', payoutOf(0), 'amount must not be less than 1'],
      [
        'an unsupported currency',
        payoutOf(1000, { currency: 'XYZ' }),
        'currency must be one of',
      ],
      [
        'an undeclared field',
        payoutOf(1000, { status: 'SUCCEEDED' }),
        'property status should not exist',
      ],
    ])('rejects %s with 400', async (_case, body, message) => {
      await fund();
      const response = await payout(acme, 'payout-1', body).expect(400);
      expect(JSON.stringify(response.body)).toContain(message);
      await expect(prisma.payout.count()).resolves.toBe(0);
    });

    it('accepts account names in any script and requires an Idempotency-Key', async () => {
      await fund();
      await payout(
        acme,
        'payout-1',
        payoutOf(1000, {
          destination: { ...DESTINATION, accountName: 'Ọlá & Sons Ltd.' },
        }),
      ).expect(202);
      await payout(acme, undefined, payoutOf(1000)).expect(400);
      await expect(prisma.payout.count()).resolves.toBe(1);
    });
  });

  describe('idempotency and concurrency', () => {
    it('replays the same request and refuses the key for a different one', async () => {
      await fund();
      const first = (await payout(acme, 'payout-1', payoutOf(1000)).expect(202))
        .body as PayoutResponse;
      await drainOutbox(app, prisma);

      const replay = await payout(acme, 'payout-1', payoutOf(1000)).expect(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toMatchObject({ id: first.id, status: 'SUCCEEDED' });

      const reused = await payout(acme, 'payout-1', payoutOf(1001)).expect(409);
      expect((reused.body as ErrorResponse).message).toMatch(/Idempotency-Key/);
      await expect(prisma.payout.count()).resolves.toBe(1);
    });

    it('creates exactly one payout when identical requests race', async () => {
      await fund();

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => payout(acme, 'race', payoutOf(1000))),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 202,
      ]);
      expect(
        new Set(responses.map((r) => (r.body as PayoutResponse).id)).size,
      ).toBe(1);
      await expect(prisma.payout.count()).resolves.toBe(1);
    });

    it('never pays out more than the balance when different payouts race for it', async () => {
      await fund();

      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          payout(acme, `race-${i}`, payoutOf(200000)),
        ),
      );

      expect(responses.filter((r) => r.status === 202)).toHaveLength(2);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(4);
      const [{ total }] = await prisma.$queryRaw<{ total: bigint }[]>`
        SELECT coalesce(sum(amount), 0)::bigint AS total FROM payouts`;
      expect(total).toBe(400000n);
    });

    it('keeps payouts and balances to their merchant', async () => {
      await fund();
      const created = (
        await payout(acme, 'payout-1', payoutOf(1000)).expect(202)
      ).body as PayoutResponse;

      const foreign = await auth(
        request(server()).get(`/v1/payouts/${created.id}`),
        globex,
      )
        .send()
        .expect(404);
      expect((foreign.body as ErrorResponse).message).toBe('Payout not found');
      await payout(globex, 'payout-1', payoutOf(1000)).expect(409);
      await expect(listPayouts(globex)).resolves.toEqual({
        data: [],
        nextCursor: null,
      });
    });
  });

  describe('listing payouts', () => {
    it('lists newest first, filters by status and currency, and pages by cursor', async () => {
      await fund();
      const first = (await payout(acme, 'p1', payoutOf(1000)).expect(202))
        .body as PayoutResponse;
      await drainOutbox(app, prisma);
      const second = (await payout(acme, 'p2', payoutOf(2000)).expect(202))
        .body as PayoutResponse;
      const third = (await payout(acme, 'p3', payoutOf(3000)).expect(202))
        .body as PayoutResponse;
      await ownerDatabase().$executeRaw`
        UPDATE payouts SET created_at = created_at - interval '1 minute'
        WHERE id = ${first.id}::uuid`;

      const all = await listPayouts(acme);
      expect(all.data.map((p) => p.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
      expect(all.nextCursor).toBeNull();

      const succeeded = await listPayouts(acme, { status: 'SUCCEEDED' });
      expect(succeeded.data.map((p) => p.id)).toEqual([first.id]);
      await expect(listPayouts(acme, { currency: 'USD' })).resolves.toEqual({
        data: [],
        nextCursor: null,
      });

      const page = await listPayouts(acme, { limit: 2 });
      expect(page.data.map((p) => p.id)).toEqual([third.id, second.id]);
      const next = await listPayouts(acme, {
        limit: 2,
        cursor: page.nextCursor!,
      });
      expect(next.data.map((p) => p.id)).toEqual([first.id]);
      expect(next.nextCursor).toBeNull();

      await auth(
        request(server()).get('/v1/payouts').query({ cursor: 'nope' }),
        acme,
      )
        .send()
        .expect(400);
    });
  });

  describe('unknown outcomes and reconciliation', () => {
    it('resolves a payout whose answer was lost by looking it up, without sending it again', async () => {
      await fund();
      provider.willPayOutThenTimeOut(SimulatorOutcome.Succeeded);
      const created = (
        await payout(acme, 'payout-1', payoutOf(1000)).expect(202)
      ).body as PayoutResponse;

      await processDueJobsExpecting(app, prisma, 1);

      await expect(readPayout(acme, created.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      await expect(payoutJobs()).resolves.toEqual([
        expect.objectContaining({
          type: 'PROCESS_PAYOUT',
          status: 'COMPLETED',
        }),
        expect.objectContaining({ type: 'RECONCILE_PAYOUT', status: 'QUEUED' }),
      ]);

      await drainOutbox(app, prisma);

      await expect(readPayout(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      expect(provider.payoutSubmissions).toHaveLength(1);
      expect(provider.payoutLookups).toEqual([{ payoutId: created.id }]);
    });

    it('resubmits under the same payout ID only when the provider has no record of it', async () => {
      await fund();
      provider.willThrowOnPayout(new Error('connection reset before sending'));
      const created = (
        await payout(acme, 'payout-1', payoutOf(1000)).expect(202)
      ).body as PayoutResponse;
      await processDueJobsExpecting(app, prisma, 1);

      provider.willPayOut(SimulatorOutcome.Succeeded);
      await drainOutbox(app, prisma);

      expect(provider.payoutSubmissions.map((s) => s.payoutId)).toEqual([
        created.id,
        created.id,
      ]);
      await expect(readPayout(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      await expect(
        prisma.payoutEvent.count({
          where: { payoutId: created.id, type: 'payout.resolved' },
        }),
      ).resolves.toBe(1);
    });

    it('looks up instead of resending a payout that may already have been sent', async () => {
      await fund();
      const created = (
        await payout(acme, 'payout-1', payoutOf(1000)).expect(202)
      ).body as PayoutResponse;
      await prisma.payout.update({
        where: { id: created.id },
        data: { submittedAt: new Date() },
      });
      provider.payoutLedger.set(created.id, {
        outcome: 'succeeded',
        providerReference: 'simpo_already_sent',
      });

      await drainOutbox(app, prisma);

      expect(provider.payoutSubmissions).toHaveLength(0);
      await expect(readPayout(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        providerReference: 'simpo_already_sent',
      });
    });

    it('leaves a payout PENDING and flagged for an operator once lookups give up, then resolves it after a requeue', async () => {
      await fund();
      provider.willPayOutThenTimeOut(SimulatorOutcome.Succeeded);
      const created = (
        await payout(acme, 'payout-1', payoutOf(1000)).expect(202)
      ).body as PayoutResponse;
      provider.willLookupPayout(
        ...Array.from({ length: 10 }, () => ({
          status: 'processing' as const,
        })),
      );

      await drainOutbox(app, prisma);

      await expect(readPayout(acme, created.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      const lookup = (await payoutJobs()).find(
        (job) => job.type === 'RECONCILE_PAYOUT',
      )!;
      expect(lookup).toMatchObject({ status: 'DEAD', runCount: 10 });

      const unresolved = await runCli(app, 'payments:unresolved');
      expect(unresolved.out).toContain('Unresolved payouts, oldest first');
      expect(unresolved.out).toContain(`payout=${created.id} (NGN, acme)`);
      expect(unresolved.out).toContain('state=reconciliation_exhausted');
      const status = await runCli(app, 'ops:status');
      expect(status.out).toMatch(/Payouts awaiting an operator:\s+1/);
      expect(status.out).toContain(`RECONCILE_PAYOUT  payout=${created.id}`);

      await expect(
        runCli(app, 'outbox:requeue', '--job', lookup.id),
      ).resolves.toMatchObject({ code: 0 });
      await drainOutbox(app, prisma);

      await expect(readPayout(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      const history = await historyOf(created.id);
      expect(history.map((event) => event.type)).toEqual([
        'payout.created',
        'payout.submitted',
        'payout.outcome_unknown',
        ...Array.from({ length: 9 }, () => 'reconciliation.deferred'),
        'outbox_job.dead',
        'outbox_job.requeued',
        'payout.resolved',
      ]);
      await expect(
        ownerDatabase().operatorAuditEvent.count({
          where: { action: 'outbox_job.requeued', targetId: lookup.id },
        }),
      ).resolves.toBe(1);
    });

    it('queues a lookup for a pending payout left without live work', async () => {
      await fund();
      const created = (
        await payout(acme, 'payout-1', payoutOf(1000)).expect(202)
      ).body as PayoutResponse;
      await ownerDatabase().$executeRaw`
        UPDATE outbox_jobs SET status = 'COMPLETED', completed_at = now()
        WHERE payout_id = ${created.id}::uuid`;
      await ownerDatabase().$executeRaw`
        UPDATE payouts SET created_at = created_at - interval '1 hour'`;

      await expect(app.get(OutboxWorker).sweepStaleAttempts()).resolves.toBe(1);
      await expect(app.get(OutboxWorker).sweepStaleAttempts()).resolves.toBe(0);

      await makeJobsDue(prisma);
      await drainOutbox(app, prisma);
      await expect(readPayout(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      await expect(
        prisma.payoutEvent.count({
          where: { payoutId: created.id, type: 'reconciliation.scheduled' },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('merchant notifications', () => {
    it('delivers a signed payout.succeeded event, without the account number', async () => {
      await fund();
      const configured = await auth(
        request(server()).put('/v1/webhook-endpoint'),
        acme,
      )
        .send({ url: receiver.url })
        .expect(201);
      const secret = (configured.body as WebhookEndpointResponse).secret!;
      const created = (
        await payout(acme, 'payout-1', payoutOf(1000)).expect(202)
      ).body as PayoutResponse;

      await drainOutbox(app, prisma);

      expect(receiver.deliveries).toHaveLength(1);
      const [delivery] = receiver.deliveries;
      expect(delivery.headers['payguard-event-type']).toBe('payout.succeeded');
      expect(verifiesWith(delivery, secret)).toBe(true);
      expect(delivery.body).not.toContain('0123456789');
      expect(JSON.parse(delivery.body)).toMatchObject({
        type: 'payout.succeeded',
        data: {
          id: created.id,
          status: 'SUCCEEDED',
          destination: { accountNumberLast4: '6789' },
        },
      });
      await expect(
        prisma.outboxJob.findFirst({
          where: { type: 'DELIVER_MERCHANT_EVENT' },
          select: { payoutId: true, paymentId: true, status: true },
        }),
      ).resolves.toEqual({
        payoutId: created.id,
        paymentId: null,
        status: 'COMPLETED',
      });

      const events = (
        await auth(
          request(server())
            .get('/v1/events')
            .query({ type: 'payout.succeeded' }),
          acme,
        )
          .send()
          .expect(200)
      ).body as MerchantEventListResponse;
      expect(events.data).toEqual([
        expect.objectContaining({
          type: 'payout.succeeded',
          delivery: expect.objectContaining({ status: 'DELIVERED' }),
        }),
      ]);

      const redelivered = await auth(
        request(server()).post(`/v1/events/${events.data[0].id}/redeliver`),
        acme,
      )
        .send()
        .expect(202);
      expect(redelivered.body).toMatchObject({
        delivery: { status: 'PENDING' },
      });
      await drainOutbox(app, prisma);
      expect(receiver.deliveries).toHaveLength(2);
    });

    it('records payout.failed for a declined payout', async () => {
      await fund();
      provider.willPayOut(SimulatorOutcome.Declined);
      await payout(acme, 'payout-1', payoutOf(1000)).expect(202);

      await drainOutbox(app, prisma);

      await expect(
        prisma.merchantEvent.findMany({
          where: { payoutId: { not: null } },
          select: { type: true, paymentId: true, deliveryStatus: true },
        }),
      ).resolves.toEqual([
        { type: 'payout.failed', paymentId: null, deliveryStatus: null },
      ]);
    });
  });

  describe('history and operator tooling', () => {
    it('records the payout history and shows it in payout:inspect, without the account number', async () => {
      await fund();
      const created = (
        await payout(acme, 'payout-1', payoutOf(1500)).expect(202)
      ).body as PayoutResponse;
      await drainOutbox(app, prisma);

      const history = await historyOf(created.id);
      expect(history).toEqual([
        expect.objectContaining({
          type: 'payout.created',
          source: 'MERCHANT',
          statusBefore: null,
          statusAfter: 'PENDING',
        }),
        expect.objectContaining({ type: 'payout.submitted', source: 'WORKER' }),
        expect.objectContaining({
          type: 'payout.resolved',
          source: 'PROVIDER_RESPONSE',
          statusBefore: 'PENDING',
          statusAfter: 'SUCCEEDED',
        }),
      ]);
      for (const event of history) {
        expect(event.details).not.toHaveProperty('amount');
      }

      const inspect = await runCli(
        app,
        'payout:inspect',
        '--payout',
        created.id,
      );
      expect(inspect.code).toBe(0);
      expect(inspect.out).toContain(
        `Payout ${created.id}  SUCCEEDED  1500 NGN`,
      );
      expect(inspect.out).toContain('PROCESS_PAYOUT COMPLETED');
      expect(inspect.out).toMatch(
        /payout\.resolved\s+payout PENDING -> SUCCEEDED/,
      );
      expect(inspect.out).toContain('Verdict: SUCCEEDED');
      expect(inspect.out).not.toContain('0123456789');

      await expect(
        runCli(app, 'payout:inspect', '--payout', 'not-an-id'),
      ).resolves.toMatchObject({ code: 1 });
      await expect(
        runCli(
          app,
          'payout:inspect',
          '--payout',
          '01890000-0000-7000-8000-000000000000',
        ),
      ).resolves.toMatchObject({
        code: 1,
        err: expect.stringContaining('No payout with id'),
      });
    });

    it('reports payouts in ops:status and ops:metrics', async () => {
      await fund();
      await payout(acme, 'payout-1', payoutOf(100)).expect(202);
      await drainOutbox(app, prisma);
      await payout(acme, 'payout-2', payoutOf(100)).expect(202);

      const metrics = await runCli(app, 'ops:metrics');
      expect(metrics.out).toContain(
        'payguard_payouts{status="SUCCEEDED",failure_code="none"} 1',
      );
      expect(metrics.out).toContain('payguard_payouts_unresolved 1');
      const status = await runCli(app, 'ops:status');
      expect(status.out).toMatch(/Unresolved payouts:\s+1/);
    });

    it('keeps the completed jobs of a pending payout when pruning, and prunes those of a settled one', async () => {
      await fund();
      await payout(acme, 'payout-1', payoutOf(100)).expect(202);
      await drainOutbox(app, prisma);
      provider.willPayOutThenTimeOut(SimulatorOutcome.Succeeded);
      const pending = (
        await payout(acme, 'payout-2', payoutOf(100)).expect(202)
      ).body as PayoutResponse;
      await processDueJobsExpecting(app, prisma, 1);
      await ownerDatabase().$executeRaw`
        UPDATE outbox_jobs SET completed_at = now() - interval '60 days'
        WHERE status = 'COMPLETED'`;

      await runCli(app, 'maintenance:prune', '--completed-jobs-days', '30');

      await expect(payoutJobs()).resolves.toEqual([
        expect.objectContaining({
          type: 'PROCESS_PAYOUT',
          status: 'COMPLETED',
          payoutId: pending.id,
        }),
        expect.objectContaining({ type: 'RECONCILE_PAYOUT', status: 'QUEUED' }),
      ]);
    });
  });

  describe('database guarantees', () => {
    const insertPayout = (
      amount: number,
      currency = 'NGN',
    ) => prisma.$executeRaw`
      INSERT INTO payouts (id, merchant_id, amount, currency, bank_code, account_number,
                           account_name, idempotency_key, request_fingerprint, updated_at)
      VALUES (gen_random_uuid(), ${acme.merchantId}::uuid, ${amount}, ${currency}, '058',
              '0123456789', 'Test Merchant Ltd', gen_random_uuid()::text, ${'0'.repeat(64)},
              now())`;

    it('refuses payouts beyond the available balance, whatever the caller', async () => {
      await fund();

      await insertPayout(400000);
      await expect(insertPayout(100001)).rejects.toThrow(
        /payouts_within_available_balance|exceeds the available balance/,
      );
      await expect(insertPayout(1, 'USD')).rejects.toThrow(
        /exceeds the available balance/,
      );
      await insertPayout(100000);
    });

    it('ties every job to a payment or a payout, and payout jobs to one payout each', async () => {
      const payment = await fund();
      const created = (
        await payout(acme, 'payout-1', payoutOf(1000)).expect(202)
      ).body as PayoutResponse;

      await expect(
        prisma.$executeRaw`
          INSERT INTO outbox_jobs (id, type, updated_at)
          VALUES (gen_random_uuid(), 'PROCESS_PAYOUT', now())`,
      ).rejects.toThrow(/outbox_jobs_(one_subject|payout_job_has_payout)/);
      await expect(
        prisma.$executeRaw`
          INSERT INTO outbox_jobs (id, type, payment_id, attempt_id, payout_id, updated_at)
          VALUES (gen_random_uuid(), 'PROCESS_PAYOUT', ${payment.id}::uuid,
                  ${payment.attempts[0].id}::uuid, ${created.id}::uuid, now())`,
      ).rejects.toThrow(/outbox_jobs_one_subject/);
      await expect(
        prisma.$executeRaw`
          INSERT INTO outbox_jobs (id, type, payout_id, updated_at)
          VALUES (gen_random_uuid(), 'PROCESS_ATTEMPT', ${created.id}::uuid, now())`,
      ).rejects.toThrow(/outbox_jobs_payout_only_on_payout_work/);
      await expect(
        prisma.$executeRaw`
          INSERT INTO outbox_jobs (id, type, payout_id, updated_at)
          VALUES (gen_random_uuid(), 'PROCESS_PAYOUT', ${created.id}::uuid, now())`,
      ).rejects.toThrow(/outbox_jobs_payout_id_type_key/);
      await expect(
        prisma.payout.update({
          where: { id: created.id },
          data: { amount: 1n },
        }),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
