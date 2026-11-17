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
  MerchantEventResponse,
  WebhookEndpointResponse,
} from '../src/merchant-webhooks/merchant-webhook.responses.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import type { RefundResponse } from '../src/refunds/refund.responses.js';
import { runCli } from './support/admin-cli.js';
import { drainOutbox, processDueJobsExpecting } from './support/outbox.js';
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

describe('Merchant webhooks (PostgreSQL)', () => {
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

  const as = (merchant: Merchant) => {
    const auth = (req: request.Test) =>
      req.set('Authorization', `Bearer ${merchant.apiKey}`);
    const server = () => app.getHttpServer();
    return {
      getEndpoint: () => auth(request(server()).get('/v1/webhook-endpoint')),
      putEndpoint: (body: object) =>
        auth(request(server()).put('/v1/webhook-endpoint')).send(body),
      rotate: () =>
        auth(request(server()).post('/v1/webhook-endpoint/rotate-secret')),
      events: (query: Record<string, string | number> = {}) =>
        auth(request(server()).get('/v1/events').query(query)),
      event: (id: string) => auth(request(server()).get(`/v1/events/${id}`)),
      redeliver: (id: string) =>
        auth(request(server()).post(`/v1/events/${id}/redeliver`)),
      refund: (paymentId: string, key: string, body: object = {}) =>
        auth(request(server()).post(`/v1/payments/${paymentId}/refunds`))
          .set('Idempotency-Key', key)
          .send(body),
    };
  };

  const configure = async (merchant: Merchant = acme) => {
    const response = await as(merchant)
      .putEndpoint({ url: receiver.url })
      .expect(201);
    return (response.body as WebhookEndpointResponse).secret!;
  };

  const pay = async (key = 'pay-1') => {
    const created = (await api.create(acme, key).expect(202))
      .body as PaymentResponse;
    await drainOutbox(app, prisma);
    return api.read(acme, created.id);
  };

  const onlyEvent = async () => {
    const events = await prisma.merchantEvent.findMany();
    expect(events).toHaveLength(1);
    return events[0];
  };

  const deliveryJobs = () =>
    prisma.outboxJob.findMany({
      where: { type: 'DELIVER_MERCHANT_EVENT' },
      select: { status: true, runCount: true, lastError: true },
    });

  describe('managing the endpoint', () => {
    it('creates the endpoint with a secret shown once, and stores the secret encrypted', async () => {
      await as(acme).getEndpoint().expect(404);

      const created = (
        await as(acme).putEndpoint({ url: receiver.url }).expect(201)
      ).body as WebhookEndpointResponse;

      expect(created).toEqual({
        url: receiver.url,
        enabled: true,
        secretRotatedAt: expect.any(String),
        previousSecretExpiresAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        secret: expect.stringMatching(/^whsec_[A-Za-z0-9_-]{43}$/),
      });
      const shown = (await as(acme).getEndpoint().expect(200))
        .body as WebhookEndpointResponse;
      expect(shown).not.toHaveProperty('secret');
      const [stored] = await ownerDatabase().$queryRaw<
        { secret_ciphertext: Uint8Array }[]
      >`SELECT secret_ciphertext FROM merchant_webhook_endpoints`;
      expect(
        Buffer.from(stored.secret_ciphertext).toString('latin1'),
      ).not.toContain(created.secret);
    });

    it('updates the URL and enabled flag without revealing or changing the secret', async () => {
      const secret = await configure();

      const updated = await as(acme)
        .putEndpoint({ url: `${receiver.url}/v2`, enabled: false })
        .expect(200);

      expect(updated.body).toMatchObject({
        url: `${receiver.url}/v2`,
        enabled: false,
      });
      expect(updated.body).not.toHaveProperty('secret');
      await as(acme)
        .putEndpoint({ url: receiver.url, enabled: true })
        .expect(200);
      await pay();
      expect(verifiesWith(receiver.deliveries[0], secret)).toBe(true);
    });

    it.each([
      ['another scheme', { url: 'ftp://127.0.0.1/hook' }, /https/],
      ['credentials', { url: 'http://u:p@127.0.0.1/hook' }, /credentials/],
      ['not a URL', { url: 'merchant/hook' }, /absolute URL/],
      ['no URL', {}, /url/],
      [
        'an unknown field',
        { url: 'http://127.0.0.1:9/hook', secret: 'mine' },
        /"field":"secret"/,
      ],
    ])('rejects %s', async (_case, body, message) => {
      const response = await as(acme).putEndpoint(body).expect(400);

      expect(JSON.stringify((response.body as ErrorResponse).details)).toMatch(
        message,
      );
      await expect(prisma.merchantWebhookEndpoint.count()).resolves.toBe(0);
    });

    it('rotates the secret and keeps signing with the previous one while it is still valid', async () => {
      await as(acme).rotate().expect(404);
      const first = await configure();

      const rotated = (await as(acme).rotate().expect(200))
        .body as WebhookEndpointResponse;

      expect(rotated.secret).toMatch(/^whsec_/);
      expect(rotated.secret).not.toBe(first);
      const overlap =
        new Date(rotated.previousSecretExpiresAt!).getTime() - Date.now();
      expect(overlap).toBeGreaterThan(23.9 * 3_600_000);
      expect(overlap).toBeLessThanOrEqual(24 * 3_600_000);

      await pay();
      const [delivery] = receiver.deliveries;
      expect(verifiesWith(delivery, rotated.secret!)).toBe(true);
      expect(verifiesWith(delivery, first)).toBe(true);
      expect(verifiesWith(delivery, 'whsec_someone_else')).toBe(false);

      await ownerDatabase().$executeRaw`
        UPDATE merchant_webhook_endpoints
        SET previous_secret_expires_at = now() - interval '1 second'`;
      receiver.reset();
      await pay('pay-2');
      expect(verifiesWith(receiver.deliveries[0], rotated.secret!)).toBe(true);
      expect(verifiesWith(receiver.deliveries[0], first)).toBe(false);
    });

    it("keeps each merchant's endpoint to itself and requires authentication", async () => {
      await configure(acme);

      await as(globex).getEndpoint().expect(404);
      await request(app.getHttpServer())
        .get('/v1/webhook-endpoint')
        .expect(401);
    });
  });

  describe('events and deliveries', () => {
    it('records an event without sending anything when no endpoint is enabled', async () => {
      const payment = await pay();

      const event = await onlyEvent();
      expect(event).toMatchObject({
        type: 'payment.succeeded',
        deliveryStatus: null,
        deliveryAttempts: 0,
      });
      await expect(deliveryJobs()).resolves.toEqual([]);
      const listed = (await as(acme).events().expect(200))
        .body as MerchantEventListResponse;
      expect(listed.data).toEqual([
        {
          id: event.id,
          type: 'payment.succeeded',
          createdAt: expect.any(String),
          data: JSON.parse(JSON.stringify(payment)) as object,
          delivery: {
            status: null,
            attempts: 0,
            lastAttemptAt: null,
            lastResponseStatus: null,
            lastError: null,
            deliveredAt: null,
          },
        },
      ]);
    });

    it('delivers a signed event for a payment outcome, once', async () => {
      const secret = await configure();

      const payment = await pay();

      expect(receiver.deliveries).toHaveLength(1);
      const [delivery] = receiver.deliveries;
      const event = await onlyEvent();
      expect(verifiesWith(delivery, secret)).toBe(true);
      expect(delivery.headers).toMatchObject({
        'payguard-event-id': event.id,
        'payguard-event-type': 'payment.succeeded',
        'content-type': 'application/json',
      });
      expect(JSON.parse(delivery.body)).toEqual({
        id: event.id,
        type: 'payment.succeeded',
        createdAt: event.createdAt.toISOString(),
        data: JSON.parse(JSON.stringify(payment)) as object,
      });
      expect(event).toMatchObject({
        deliveryStatus: 'DELIVERED',
        deliveryAttempts: 1,
        lastResponseStatus: 200,
        lastError: null,
        deliveredAt: expect.any(Date),
      });
      await expect(deliveryJobs()).resolves.toEqual([
        expect.objectContaining({ status: 'COMPLETED', runCount: 1 }),
      ]);
    });

    it('notifies declines and refund outcomes too', async () => {
      await configure();
      provider.willReturn(SimulatorOutcome.Declined);
      await pay('declined');
      provider.willReturn(SimulatorOutcome.Succeeded);
      const payment = await pay('paid');
      const refund = (
        await as(acme).refund(payment.id, 'r1', { amount: 100 }).expect(202)
      ).body as RefundResponse;
      provider.willRefund(SimulatorOutcome.Declined);
      await drainOutbox(app, prisma);
      provider.willRefund(SimulatorOutcome.Succeeded);
      await as(acme).refund(payment.id, 'r2', { amount: 200 }).expect(202);
      await drainOutbox(app, prisma);

      const types = receiver.deliveries.map(
        (delivery) => (JSON.parse(delivery.body) as { type: string }).type,
      );
      expect(types.sort()).toEqual([
        'payment.failed',
        'payment.succeeded',
        'refund.failed',
        'refund.succeeded',
      ]);
      const failedRefund = receiver.deliveries
        .map((d) => JSON.parse(d.body) as MerchantEventResponse)
        .find((e) => e.type === 'refund.failed')!;
      expect(failedRefund.data).toMatchObject({
        id: refund.id,
        paymentId: payment.id,
        status: 'FAILED',
        failureCode: 'DECLINED',
      });
    });

    it('retries a failing endpoint with backoff and records each attempt', async () => {
      await configure();
      receiver.answerWith(500);
      const created = (await api.create(acme, 'pay-1').expect(202))
        .body as PaymentResponse;
      await processDueJobsExpecting(app, prisma, 1);
      await processDueJobsExpecting(app, prisma, 1);

      let event = await onlyEvent();
      expect(event).toMatchObject({
        paymentId: created.id,
        deliveryStatus: 'PENDING',
        deliveryAttempts: 1,
        lastResponseStatus: 500,
        lastError: 'HTTP_STATUS',
      });
      const [{ delay }] = await prisma.$queryRaw<{ delay: number }[]>`
        SELECT extract(epoch FROM available_at - now())::int AS delay
        FROM outbox_jobs WHERE type = 'DELIVER_MERCHANT_EVENT'`;
      expect(delay).toBeGreaterThan(25);
      expect(delay).toBeLessThanOrEqual(30);

      receiver.answerWith(204);
      await drainOutbox(app, prisma);

      event = await onlyEvent();
      expect(event).toMatchObject({
        deliveryStatus: 'DELIVERED',
        deliveryAttempts: 2,
        lastResponseStatus: 204,
        lastError: null,
      });
      expect(receiver.deliveries).toHaveLength(2);
      expect(
        new Set(receiver.deliveries.map((d) => d.headers['payguard-event-id'])),
      ).toEqual(new Set([event.id]));
    });

    it('marks the event FAILED once retries run out, without a dead job or degraded health', async () => {
      await configure();
      receiver.answerWith(503);

      await pay();

      expect(await onlyEvent()).toMatchObject({
        deliveryStatus: 'FAILED',
        deliveryAttempts: 10,
        lastResponseStatus: 503,
      });
      await expect(deliveryJobs()).resolves.toEqual([
        expect.objectContaining({ status: 'COMPLETED', runCount: 10 }),
      ]);
      expect(receiver.deliveries).toHaveLength(10);
      await expect(
        prisma.outboxJob.count({ where: { status: 'DEAD' } }),
      ).resolves.toBe(0);
    });

    it('does not send to an endpoint disabled after the event was recorded', async () => {
      await configure();
      await api.create(acme, 'pay-1').expect(202);
      await processDueJobsExpecting(app, prisma, 1);
      await as(acme)
        .putEndpoint({ url: receiver.url, enabled: false })
        .expect(200);

      await drainOutbox(app, prisma);

      expect(receiver.deliveries).toHaveLength(0);
      expect(await onlyEvent()).toMatchObject({
        deliveryStatus: 'FAILED',
        deliveryAttempts: 0,
        lastError: 'ENDPOINT_DISABLED',
      });
    });

    it('redelivers an event on request, with the same event ID', async () => {
      await configure();
      receiver.answerWith(500);
      await pay();
      const failed = await onlyEvent();
      expect(failed.deliveryStatus).toBe('FAILED');

      receiver.reset();
      const accepted = await as(acme).redeliver(failed.id).expect(202);
      expect((accepted.body as MerchantEventResponse).delivery.status).toBe(
        'PENDING',
      );
      await as(acme).redeliver(failed.id).expect(202);
      await drainOutbox(app, prisma);

      expect(receiver.deliveries).toHaveLength(1);
      expect(receiver.deliveries[0].headers['payguard-event-id']).toBe(
        failed.id,
      );
      const delivered = (await as(acme).event(failed.id).expect(200))
        .body as MerchantEventResponse;
      expect(delivered.delivery).toMatchObject({
        status: 'DELIVERED',
        attempts: 11,
      });

      await as(acme).redeliver(failed.id).expect(202);
      await drainOutbox(app, prisma);
      expect(receiver.deliveries).toHaveLength(2);
    });

    it('redelivers an event recorded before any endpoint existed', async () => {
      await pay();
      const event = await onlyEvent();
      await as(acme).redeliver(event.id).expect(409);

      await configure();
      await as(acme).redeliver(event.id).expect(202);
      await drainOutbox(app, prisma);

      expect(receiver.deliveries).toHaveLength(1);
      await expect(onlyEvent()).resolves.toMatchObject({
        deliveryStatus: 'DELIVERED',
      });
    });

    it("keeps each merchant's events to itself", async () => {
      await configure(acme);
      await pay();
      const event = await onlyEvent();

      await as(globex).event(event.id).expect(404);
      await as(globex).redeliver(event.id).expect(404);
      await expect(as(globex).events()).resolves.toMatchObject({
        body: { data: [], nextCursor: null },
      });
    });

    it('lists events newest first, filtered and paginated', async () => {
      provider.willReturn(SimulatorOutcome.Declined);
      const declined = await pay('declined');
      provider.willReturn(SimulatorOutcome.Succeeded);
      const paid = await pay('paid');
      await as(acme).refund(paid.id, 'r1', { amount: 1 }).expect(202);
      await drainOutbox(app, prisma);
      await ownerDatabase().$executeRaw`
        UPDATE merchant_events SET created_at = CASE type
          WHEN 'payment.failed' THEN '2026-11-01T00:00:00Z'::timestamptz
          WHEN 'payment.succeeded' THEN '2026-11-02T00:00:00Z'::timestamptz
          ELSE '2026-11-03T00:00:00Z'::timestamptz END`;

      const first = (await as(acme).events({ limit: 2 }).expect(200))
        .body as MerchantEventListResponse;
      const second = (
        await as(acme)
          .events({ limit: 2, cursor: first.nextCursor! })
          .expect(200)
      ).body as MerchantEventListResponse;

      expect([...first.data, ...second.data].map((e) => e.type)).toEqual([
        'refund.succeeded',
        'payment.succeeded',
        'payment.failed',
      ]);
      expect(second.nextCursor).toBeNull();
      const byType = (
        await as(acme).events({ type: 'payment.failed' }).expect(200)
      ).body as MerchantEventListResponse;
      expect(byType.data.map((e) => (e.data as { id: string }).id)).toEqual([
        declined.id,
      ]);
      const byPayment = (
        await as(acme).events({ paymentId: paid.id }).expect(200)
      ).body as MerchantEventListResponse;
      expect(byPayment.data).toHaveLength(2);
      await as(acme).events({ type: 'payment.created' }).expect(400);
    });
  });

  describe('operator tooling', () => {
    it('shows merchant events in payment:inspect and ops:metrics', async () => {
      await configure();
      const payment = await pay();
      const event = await onlyEvent();

      const inspect = await runCli(
        app,
        'payment:inspect',
        '--payment',
        payment.id,
      );
      expect(inspect.out).toContain('Merchant events:');
      expect(inspect.out).toMatch(
        new RegExp(
          `${event.id}\\s+payment\\.succeeded\\s+delivery=DELIVERED\\s+attempts=1\\s+lastStatus=200`,
        ),
      );
      expect(inspect.out).toContain('DELIVER_MERCHANT_EVENT COMPLETED');

      const metrics = await runCli(app, 'ops:metrics');
      expect(metrics.out).toContain(
        'payguard_merchant_events{status="DELIVERED"} 1',
      );
    });
  });
});
