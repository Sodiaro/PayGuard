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
import type { App } from 'supertest/types.js';
import { AppLogger } from '../src/common/logging/app-logger.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import { webhookSignatureHeader } from '../src/webhooks/webhook-signature.js';
import { failWritesTo } from './support/db-faults.js';
import { drainOutbox } from './support/outbox.js';
import { paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';
import {
  eventFor,
  nowSeconds,
  testWebhookSecret,
  webhooksApi,
} from './support/webhooks.js';

describe('Provider webhook intake (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let api: ReturnType<typeof paymentsApi>;
  let webhooks: ReturnType<typeof webhooksApi>;
  let worker: OutboxWorker;
  let acme: Merchant;
  let logOutput: string[];

  beforeAll(async () => {
    app = await createTestApp({
      provider,
      logger: new AppLogger({ json: true }),
    });
    prisma = prismaOf(app);
    api = paymentsApi(app);
    webhooks = webhooksApi(app);
    worker = app.get(OutboxWorker);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    provider.reset();
    acme = await provisionMerchant(app, 'acme');

    logOutput = [];
    const capture = (chunk: string | Uint8Array) => {
      logOutput.push(String(chunk));
      return true;
    };
    jest.spyOn(process.stdout, 'write').mockImplementation(capture);
    jest.spyOn(process.stderr, 'write').mockImplementation(capture);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  // Submitted, but the provider's answer was lost: the attempt waits for an outcome.
  const createAwaitingPayment = async () => {
    provider.willProcessThenTimeOut(SimulatorOutcome.Succeeded);
    const payment = (await api.create(acme, 'key-1').expect(202))
      .body as PaymentResponse;
    await worker.processDueJobs();
    return payment;
  };

  const storedEvents = () =>
    prisma.providerWebhookEvent.findMany({ orderBy: { receivedAt: 'asc' } });
  const webhookJobs = () =>
    prisma.outboxJob.findMany({ where: { type: 'APPLY_WEBHOOK_EVENT' } });

  describe('authentication', () => {
    it('accepts a correctly signed event, stores it and queues its processing', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');

      const response = await webhooks.deliver(event).expect(202);

      expect(response.body).toEqual({ status: 'accepted' });
      const [stored] = await storedEvents();
      expect(stored).toMatchObject({
        provider: 'simulator',
        eventId: event.id,
        eventType: 'payment.succeeded',
        attemptId: payment.attempts[0].id,
        amount: 500000n,
        currency: 'NGN',
        status: 'RECEIVED',
        result: null,
      });
      expect(await webhookJobs()).toEqual([
        expect.objectContaining({
          webhookEventId: stored.id,
          attemptId: payment.attempts[0].id,
          status: 'QUEUED',
        }),
      ]);
      // Acknowledged, not yet applied: the payment changes only when the worker runs.
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
    });

    it('rejects a signature made with another secret', async () => {
      const payment = await createAwaitingPayment();

      await webhooks
        .deliver(eventFor(payment, 'payment.succeeded'), {
          secret: 'not-the-configured-secret-0123456789abcdef',
        })
        .expect(401);
    });

    it('rejects a merchant API key in place of a signature', async () => {
      const payment = await createAwaitingPayment();

      await webhooks
        .deliver(eventFor(payment, 'payment.succeeded'), {
          signature: null,
          headers: { Authorization: `Bearer ${acme.apiKey}` },
        })
        .expect(401);
    });

    it.each([
      ['missing', null],
      ['garbage', 'garbage'],
      ['without a timestamp', `v1=${'a'.repeat(64)}`],
      ['with uppercase hex', 'UPPER'],
      ['base64-encoded', 'BASE64'],
      ['too short', 'SHORT'],
    ])('rejects a signature header that is %s', async (_case, header) => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');
      const timestamp = nowSeconds();
      const valid = webhookSignatureHeader(
        testWebhookSecret(),
        timestamp,
        JSON.stringify(event),
      );
      const hex = valid.split('v1=')[1];
      const signature =
        header === 'UPPER'
          ? `t=${timestamp},v1=${hex.toUpperCase()}`
          : header === 'BASE64'
            ? `t=${timestamp},v1=${Buffer.from(hex, 'hex').toString('base64')}`
            : header === 'SHORT'
              ? `t=${timestamp},v1=${hex.slice(0, 32)}`
              : header;

      const response = await webhooks.deliver(event, { signature }).expect(401);
      expect(response.body).toMatchObject({
        message: 'Invalid webhook signature',
      });
    });

    // Well outside the 300 s tolerance: the server reads its clock after the test does, so an
    // offset at the edge would pass or fail depending on a second boundary. The unit tests pin
    // the exact edges with a fixed clock.
    it.each([
      ['stale', -360],
      ['too far in the future', 360],
    ])('rejects a %s signed timestamp', async (_case, offset) => {
      const payment = await createAwaitingPayment();

      await webhooks
        .deliver(eventFor(payment, 'payment.succeeded'), {
          timestamp: nowSeconds() + offset,
        })
        .expect(401);
    });

    it('verifies the exact bytes received, not their JSON meaning', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');
      const compact = JSON.stringify(event);
      const pretty = JSON.stringify(event, null, 2);

      await webhooks.deliver(pretty, { signedBody: compact }).expect(401);
      await webhooks.deliver(pretty).expect(202);
    });
  });

  describe('validation', () => {
    it.each([
      ['malformed JSON', '{"id":'],
      ['a JSON array', '[]'],
      ['a JSON string', '"payment.succeeded"'],
    ])('rejects %s even when signed', async (_case, body) => {
      await webhooks.deliver(body).expect(400);
    });

    it('rejects signed bytes that are not valid UTF-8', async () => {
      await webhooks
        .deliver(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]))
        .expect(400);
    });

    it.each([
      ['an unsupported event type', { type: 'payment.refunded' }, 'type'],
      ['a merchant ID', { merchantId: 'x' }, 'merchantId'],
      ['a missing createdAt', { createdAt: undefined }, 'createdAt'],
    ])('rejects a signed event with %s', async (_case, change, field) => {
      const payment = await createAwaitingPayment();
      const event = { ...eventFor(payment, 'payment.succeeded'), ...change };

      const response = await webhooks
        .deliver(JSON.stringify(event))
        .expect(400);

      expect(
        (response.body as { details: { field: string }[] }).details.map(
          (detail) => detail.field,
        ),
      ).toContain(field);
    });

    it('rejects a body over the size limit before verifying it', async () => {
      const payment = await createAwaitingPayment();
      const event = {
        ...eventFor(payment, 'payment.succeeded'),
        padding: 'x'.repeat(70 * 1024),
      };

      await webhooks.deliver(JSON.stringify(event)).expect(413);
    });

    it.each(['text/plain', 'application/x-www-form-urlencoded'])(
      'rejects Content-Type %s',
      async (contentType) => {
        const payment = await createAwaitingPayment();

        await webhooks
          .deliver(eventFor(payment, 'payment.succeeded'), { contentType })
          .expect(415);
      },
    );

    it('refuses compressed bodies instead of inflating them', async () => {
      const payment = await createAwaitingPayment();

      await webhooks
        .deliver(eventFor(payment, 'payment.succeeded'), {
          headers: { 'Content-Encoding': 'gzip' },
        })
        .expect(415);
    });

    it('stores and queues nothing for any rejected delivery', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');

      await webhooks.deliver(event, { signature: null }).expect(401);
      await webhooks
        .deliver(event, { timestamp: nowSeconds() - 3600 })
        .expect(401);
      await webhooks.deliver('{"id":').expect(400);
      await webhooks
        .deliver(JSON.stringify({ ...event, type: 'payment.refunded' }))
        .expect(400);

      expect(await storedEvents()).toEqual([]);
      expect(await webhookJobs()).toEqual([]);
      await drainOutbox(app, prisma);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      // Resolved by reconciliation's lookup, not by any of the rejected events.
      expect(provider.lookups).toHaveLength(1);
    });
  });

  describe('deduplication', () => {
    it('acknowledges a repeated delivery without storing or queuing it again', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');

      await webhooks.deliver(event).expect(202);
      const repeat = await webhooks.deliver(event).expect(200);
      // A redelivery signed later, with a different timestamp, is still the same event.
      await webhooks
        .deliver(event, { timestamp: nowSeconds() - 60 })
        .expect(200);

      expect(repeat.body).toEqual({ status: 'duplicate' });
      expect(await storedEvents()).toEqual([
        expect.objectContaining({ duplicateDeliveries: 2 }),
      ]);
      expect(await webhookJobs()).toHaveLength(1);
    });

    it('stores one event when the same delivery arrives concurrently', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');

      const statuses = (
        await Promise.all(
          Array.from({ length: 6 }, () => webhooks.deliver(event)),
        )
      ).map((response) => response.status);

      expect(statuses.filter((status) => status === 202)).toHaveLength(1);
      expect(statuses.filter((status) => status === 200)).toHaveLength(5);
      expect(await storedEvents()).toHaveLength(1);
      expect(await webhookJobs()).toHaveLength(1);
    });

    it('rejects an event ID reused with different content and keeps the original', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');
      const forged = { ...event, type: 'payment.declined' as const };

      await webhooks.deliver(event).expect(202);
      const response = await webhooks.deliver(forged).expect(409);

      expect(response.body).toMatchObject({
        message: 'Event ID was already received with different content',
      });
      expect(await storedEvents()).toEqual([
        expect.objectContaining({
          eventType: 'payment.succeeded',
          conflictingDeliveries: 1,
          lastConflictAt: expect.any(Date) as unknown as Date,
        }),
      ]);
      expect(await webhookJobs()).toHaveLength(1);
    });
  });

  describe('durable acceptance', () => {
    it('returns a retryable 503 and stores nothing when the event cannot be written', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');
      const restore = await failWritesTo(
        prisma,
        'provider_webhook_events',
        'INSERT',
      );
      try {
        const response = await webhooks.deliver(event).expect(503);
        expect(JSON.stringify(response.body)).not.toMatch(
          /injected|provider_webhook_events|sql/i,
        );
      } finally {
        await restore();
      }
      expect(await storedEvents()).toEqual([]);

      // The provider's retry succeeds once storage is back.
      await webhooks.deliver(event).expect(202);
    });

    it('never acknowledges an event whose processing could not be queued', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(payment, 'payment.succeeded');
      const restore = await failWritesTo(prisma, 'outbox_jobs', 'INSERT');
      try {
        await webhooks.deliver(event).expect(503);
      } finally {
        await restore();
      }

      // The event and its job are written together: neither exists alone.
      expect(await storedEvents()).toEqual([]);
      expect(await webhookJobs()).toEqual([]);
      await webhooks.deliver(event).expect(202);
      expect(await webhookJobs()).toHaveLength(1);
    });

    it('records an event for an unknown attempt without queuing work or touching payments', async () => {
      const payment = await createAwaitingPayment();
      const event = eventFor(
        {
          ...payment,
          attempts: [
            {
              ...payment.attempts[0],
              id: '019a0000-0000-7000-8000-000000000000',
            },
          ],
        },
        'payment.succeeded',
      );

      await webhooks.deliver(event).expect(202);

      expect(await storedEvents()).toEqual([
        expect.objectContaining({
          status: 'PROCESSED',
          result: 'UNKNOWN_ATTEMPT',
        }),
      ]);
      expect(await webhookJobs()).toEqual([]);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'PENDING',
        attempts: [{ status: 'PENDING' }],
      });
    });
  });

  it('never logs the secret, the signature or the raw body', async () => {
    const payment = await createAwaitingPayment();
    const event = eventFor(payment, 'payment.succeeded');
    const body = JSON.stringify(event);
    const timestamp = nowSeconds();
    const signature = webhookSignatureHeader(
      testWebhookSecret(),
      timestamp,
      body,
    );

    await webhooks.deliver(body, { signature }).expect(202);
    await webhooks.deliver(body, { signature }).expect(200);
    // Always a different last digit: replacing it with a fixed one leaves 1 in 16 signatures valid.
    const tampered =
      signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
    await webhooks.deliver(body, { signature: tampered }).expect(401);
    await webhooks.deliver(JSON.stringify({ ...event, type: 'x' })).expect(400);
    await drainOutbox(app, prisma);

    const logs = logOutput.join('');
    expect(logs).toContain('Webhook event accepted');
    expect(logs).toContain('Webhook rejected');
    expect(logs).not.toContain(testWebhookSecret());
    expect(logs).not.toContain(signature.split('v1=')[1]);
    expect(logs).not.toContain(event.data.providerReference);
    expect(logs).not.toContain(body);
  });
});
