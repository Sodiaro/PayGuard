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
  PaymentListResponse,
  PaymentResponse,
} from '../src/payments/payment.responses.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import type { RefundResponse } from '../src/refunds/refund.responses.js';
import { runCli } from './support/admin-cli.js';
import { drainOutbox, processDueJobsExpecting } from './support/outbox.js';
import { ORDER, paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';
import { eventFor, webhooksApi } from './support/webhooks.js';

const MANUAL = { ...ORDER, captureMethod: 'MANUAL' };

describe('Manual capture (PostgreSQL)', () => {
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

  const act = (
    merchant: Merchant,
    paymentId: string,
    action: 'capture' | 'void',
    key: string | undefined,
    body: object = {},
  ) => {
    const req = request(app.getHttpServer())
      .post(`/v1/payments/${paymentId}/${action}`)
      .set('Authorization', `Bearer ${merchant.apiKey}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const capture = (paymentId: string, key: string, body: object = {}) =>
    act(acme, paymentId, 'capture', key, body);
  const voidIt = (paymentId: string, key: string) =>
    act(acme, paymentId, 'void', key);
  const refund = (paymentId: string, key: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/v1/payments/${paymentId}/refunds`)
      .set('Authorization', `Bearer ${acme.apiKey}`)
      .set('Idempotency-Key', key)
      .send(body);

  const authorized = async (key = 'pay-1') => {
    const created = (await api.create(acme, key, MANUAL).expect(202))
      .body as PaymentResponse;
    await drainOutbox(app, prisma);
    return api.read(acme, created.id);
  };

  const message = (response: { body: unknown }) =>
    (response.body as ErrorResponse).message;

  describe('authorizing', () => {
    it('authorizes a manual-capture payment instead of charging it', async () => {
      const created = (await api.create(acme, 'pay-1', MANUAL).expect(202))
        .body as PaymentResponse;
      expect(created).toMatchObject({
        status: 'PENDING',
        captureMethod: 'MANUAL',
      });

      await drainOutbox(app, prisma);

      const payment = await api.read(acme, created.id);
      expect(payment).toMatchObject({
        status: 'AUTHORIZED',
        captureMethod: 'MANUAL',
        amountCaptured: null,
        actions: [],
        attempts: [
          {
            status: 'SUCCEEDED',
            providerReference: expect.stringMatching(/^sim_/),
          },
        ],
      });
      expect(provider.submissions).toEqual([
        expect.objectContaining({
          attemptId: payment.attempts[0].id,
          capture: false,
        }),
      ]);
    });

    it('keeps automatic capture as the default and replays it as before', async () => {
      const created = (await api.create(acme, 'pay-1').expect(202))
        .body as PaymentResponse;
      await drainOutbox(app, prisma);

      await expect(api.read(acme, created.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        captureMethod: 'AUTOMATIC',
        amountCaptured: ORDER.amount,
      });
      await api
        .create(acme, 'pay-1', { ...ORDER, captureMethod: 'AUTOMATIC' })
        .expect(200);
      await api.create(acme, 'pay-1', MANUAL).expect(409);
    });

    it('rejects an unknown capture method', async () => {
      const response = await api
        .create(acme, 'pay-1', { ...ORDER, captureMethod: 'later' })
        .expect(400);
      expect(
        (response.body as ErrorResponse).details?.map((d) => d.field),
      ).toEqual(['captureMethod']);
    });

    it('authorizes again through a retry after a declined authorization', async () => {
      provider.willReturn(SimulatorOutcome.Declined);
      const created = (await api.create(acme, 'pay-1', MANUAL).expect(202))
        .body as PaymentResponse;
      await drainOutbox(app, prisma);
      provider.willReturn(SimulatorOutcome.Succeeded);

      await api.retry(acme, created.id, 'retry-1').expect(202);
      await drainOutbox(app, prisma);

      await expect(api.read(acme, created.id)).resolves.toMatchObject({
        status: 'AUTHORIZED',
        attempts: [{ status: 'FAILED' }, { status: 'SUCCEEDED' }],
      });
      expect(provider.submissions.map((s) => s.capture)).toEqual([
        false,
        false,
      ]);
    });

    it('applies a provider payment.authorized webhook, and distrusts payment.succeeded', async () => {
      provider.willProcessThenTimeOut(SimulatorOutcome.Succeeded);
      const created = (await api.create(acme, 'pay-1', MANUAL).expect(202))
        .body as PaymentResponse;
      await processDueJobsExpecting(app, prisma, 1);

      await webhooksApi(app)
        .deliver(eventFor(created, 'payment.succeeded'))
        .expect(202);
      await webhooksApi(app)
        .deliver(eventFor(created, 'payment.authorized'))
        .expect(202);
      await processDueJobsExpecting(app, prisma, 2);

      await expect(api.read(acme, created.id)).resolves.toMatchObject({
        status: 'AUTHORIZED',
      });
      const results = await prisma.providerWebhookEvent.findMany({
        orderBy: { eventType: 'asc' },
        select: { eventType: true, result: true },
      });
      expect(results).toEqual([
        { eventType: 'payment.authorized', result: 'APPLIED' },
        { eventType: 'payment.succeeded', result: 'DATA_MISMATCH' },
      ]);
    });
  });

  describe('capturing', () => {
    it('captures the whole authorization by default', async () => {
      const payment = await authorized();

      const accepted = (await capture(payment.id, 'cap-1').expect(202))
        .body as PaymentResponse;

      expect(accepted).toMatchObject({
        status: 'AUTHORIZED',
        actions: [
          {
            type: 'CAPTURE',
            amount: ORDER.amount,
            status: 'PENDING',
            completedAt: null,
          },
        ],
      });
      expect(provider.actionSubmissions).toHaveLength(0);

      await drainOutbox(app, prisma);

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        amountCaptured: ORDER.amount,
        actions: [
          {
            type: 'CAPTURE',
            status: 'SUCCEEDED',
            providerReference: expect.stringMatching(/^simcp_/),
          },
        ],
      });
      expect(provider.actionSubmissions).toEqual([
        {
          type: 'capture',
          actionId: accepted.actions[0].id,
          attemptId: payment.attempts[0].id,
          providerReference: payment.attempts[0].providerReference,
          amount: ORDER.amount,
          currency: 'NGN',
        },
      ]);
    });

    it('captures part of the authorization and limits refunds to what was captured', async () => {
      const payment = await authorized();

      await capture(payment.id, 'cap-1', { amount: 200000 }).expect(202);
      await drainOutbox(app, prisma);

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        amount: ORDER.amount,
        amountCaptured: 200000,
      });
      const over = await refund(payment.id, 'r1', { amount: 200001 }).expect(
        409,
      );
      expect(message(over)).toBe(
        'Payment cannot be refunded: amount_exceeds_refundable',
      );
      const full = (await refund(payment.id, 'r2').expect(202))
        .body as RefundResponse;
      expect(full.amount).toBe(200000);
    });

    it.each([
      ['an automatic payment', 'automatic'],
      ['a manual payment still pending', 'pending'],
      ['a captured payment', 'captured'],
    ])('refuses to capture %s', async (_case, state) => {
      let paymentId: string;
      if (state === 'automatic') {
        paymentId = (
          (await api.create(acme, 'pay-1').expect(202)).body as PaymentResponse
        ).id;
        await drainOutbox(app, prisma);
      } else if (state === 'pending') {
        paymentId = (
          (await api.create(acme, 'pay-1', MANUAL).expect(202))
            .body as PaymentResponse
        ).id;
      } else {
        paymentId = (await authorized()).id;
        await capture(paymentId, 'cap-0').expect(202);
        await drainOutbox(app, prisma);
      }

      const response = await capture(paymentId, 'cap-1').expect(409);

      expect(message(response)).toBe(
        'Payment cannot be captured: payment_not_authorized',
      );
    });

    it('refuses to capture more than was authorized', async () => {
      const payment = await authorized();

      const response = await capture(payment.id, 'cap-1', {
        amount: ORDER.amount + 1,
      }).expect(409);

      expect(message(response)).toBe(
        'Payment cannot be captured: amount_exceeds_authorized',
      );
      await expect(prisma.paymentAction.count()).resolves.toBe(0);
    });

    it('keeps the payment authorized after a declined capture, so it can be captured again', async () => {
      const payment = await authorized();
      provider.willAct(SimulatorOutcome.Declined);
      await capture(payment.id, 'cap-1').expect(202);
      await drainOutbox(app, prisma);

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'AUTHORIZED',
        actions: [{ status: 'FAILED', failureCode: 'DECLINED' }],
      });

      provider.willAct(SimulatorOutcome.Succeeded);
      await capture(payment.id, 'cap-2').expect(202);
      await drainOutbox(app, prisma);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
        actions: [{ status: 'FAILED' }, { status: 'SUCCEEDED' }],
      });
    });

    it('rejects an invalid capture body', async () => {
      const payment = await authorized();

      for (const body of [
        { amount: 0 },
        { amount: '100' },
        { currency: 'USD' },
      ]) {
        await capture(payment.id, 'cap-1', body).expect(400);
      }
      await act(acme, payment.id, 'capture', undefined).expect(400);
      await expect(prisma.paymentAction.count()).resolves.toBe(0);
    });
  });

  describe('voiding', () => {
    it('voids an authorization, after which it can be neither captured nor refunded', async () => {
      const payment = await authorized();

      await voidIt(payment.id, 'void-1').expect(202);
      await drainOutbox(app, prisma);

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'CANCELED',
        amountCaptured: null,
        actions: [
          {
            type: 'VOID',
            amount: null,
            status: 'SUCCEEDED',
            providerReference: expect.stringMatching(/^simvd_/),
          },
        ],
      });
      expect(message(await capture(payment.id, 'cap-1').expect(409))).toBe(
        'Payment cannot be captured: payment_not_authorized',
      );
      expect(message(await voidIt(payment.id, 'void-2').expect(409))).toBe(
        'Payment cannot be voided: payment_not_authorized',
      );
      expect(message(await refund(payment.id, 'r1').expect(409))).toBe(
        'Payment cannot be refunded: payment_not_succeeded',
      );
    });

    it('refuses to refund an authorized payment before capture', async () => {
      const payment = await authorized();

      expect(message(await refund(payment.id, 'r1').expect(409))).toBe(
        'Payment cannot be refunded: payment_not_succeeded',
      );
    });

    it('lists payments by their new statuses', async () => {
      const voided = await authorized('pay-1');
      await authorized('pay-2');
      await voidIt(voided.id, 'void-1').expect(202);
      await drainOutbox(app, prisma);

      const listed = async (status: string) =>
        (
          (await api.list(acme, { status }).expect(200))
            .body as PaymentListResponse
        ).data.length;
      await expect(listed('AUTHORIZED')).resolves.toBe(1);
      await expect(listed('CANCELED')).resolves.toBe(1);
    });
  });

  describe('idempotency and concurrency', () => {
    it('replays a capture without a second action or provider call', async () => {
      const payment = await authorized();
      await capture(payment.id, 'cap-1', { amount: 100 }).expect(202);
      await drainOutbox(app, prisma);

      const replay = await capture(payment.id, 'cap-1', { amount: 100 }).expect(
        200,
      );

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect((replay.body as PaymentResponse).status).toBe('SUCCEEDED');
      await drainOutbox(app, prisma);
      expect(provider.actionSubmissions).toHaveLength(1);
      await expect(prisma.paymentAction.count()).resolves.toBe(1);
    });

    it.each([
      ['a different amount', 'capture', { amount: 101 }],
      ['a full capture', 'capture', {}],
      ['a void', 'void', {}],
    ] as const)(
      'returns 409 when a capture key is reused for %s',
      async (_case, action, body) => {
        const payment = await authorized();
        await capture(payment.id, 'key-1', { amount: 100 }).expect(202);

        const response = await act(
          acme,
          payment.id,
          action,
          'key-1',
          body,
        ).expect(409);

        expect(message(response)).toContain('different request');
        await expect(prisma.paymentAction.count()).resolves.toBe(1);
      },
    );

    it('refuses a second capture or a void while a capture is in flight', async () => {
      const payment = await authorized();
      await capture(payment.id, 'cap-1').expect(202);

      expect(message(await capture(payment.id, 'cap-2').expect(409))).toBe(
        'Payment cannot be captured: action_in_progress',
      );
      expect(message(await voidIt(payment.id, 'void-1').expect(409))).toBe(
        'Payment cannot be voided: action_in_progress',
      );
    });

    it('accepts exactly one of a capture and a void that race', async () => {
      const payment = await authorized();

      const responses = await Promise.all([
        ...Array.from({ length: 3 }, (_, i) => capture(payment.id, `cap-${i}`)),
        ...Array.from({ length: 3 }, (_, i) => voidIt(payment.id, `void-${i}`)),
      ]);

      expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
      await drainOutbox(app, prisma);
      const final = await api.read(acme, payment.id);
      expect(['SUCCEEDED', 'CANCELED']).toContain(final.status);
      expect(final.actions).toHaveLength(1);
    });

    it("treats another merchant's payment exactly like a missing one", async () => {
      const payment = await authorized();

      await act(globex, payment.id, 'capture', 'cap-1').expect(404);
      await act(globex, payment.id, 'void', 'void-1').expect(404);
      await capture('01890000-0000-7000-8000-000000000000', 'cap-1').expect(
        404,
      );
    });
  });

  describe('unknown outcomes', () => {
    it('resolves a capture whose answer was lost by looking it up, without capturing twice', async () => {
      const payment = await authorized();
      provider.willActThenTimeOut(SimulatorOutcome.Succeeded);
      await capture(payment.id, 'cap-1').expect(202);

      await processDueJobsExpecting(app, prisma, 1);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'AUTHORIZED',
        actions: [{ status: 'PENDING' }],
      });

      await drainOutbox(app, prisma);

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      expect(provider.actionSubmissions).toHaveLength(1);
      expect(provider.actionLookups).toEqual([
        { actionId: expect.any(String), type: 'capture' },
      ]);
    });

    it('resubmits a void under the same action ID only when the provider has no record of it', async () => {
      const payment = await authorized();
      provider.willThrowOnAction(new Error('connection reset before sending'));
      await voidIt(payment.id, 'void-1').expect(202);
      await processDueJobsExpecting(app, prisma, 1);

      provider.willAct(SimulatorOutcome.Succeeded);
      await drainOutbox(app, prisma);

      const ids = provider.actionSubmissions.map((s) => s.actionId);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(1);
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'CANCELED',
      });
    });
  });

  describe('history, notifications and operator tooling', () => {
    it('records the authorization, the capture and their merchant events', async () => {
      const payment = await authorized();
      provider.willAct(SimulatorOutcome.Declined);
      await capture(payment.id, 'cap-1').expect(202);
      await drainOutbox(app, prisma);
      provider.willAct(SimulatorOutcome.Succeeded);
      await capture(payment.id, 'cap-2', { amount: 300000 }).expect(202);
      await drainOutbox(app, prisma);

      const history = await prisma.paymentEvent.findMany({
        where: { paymentId: payment.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          type: true,
          paymentStatusBefore: true,
          paymentStatusAfter: true,
          paymentActionId: true,
        },
      });
      expect(history).toEqual([
        expect.objectContaining({ type: 'payment.created' }),
        expect.objectContaining({ type: 'attempt.submitted' }),
        expect.objectContaining({
          type: 'attempt.resolved',
          paymentStatusBefore: 'PENDING',
          paymentStatusAfter: 'AUTHORIZED',
        }),
        expect.objectContaining({ type: 'action.created' }),
        expect.objectContaining({ type: 'action.submitted' }),
        expect.objectContaining({
          type: 'action.resolved',
          paymentStatusBefore: null,
          paymentStatusAfter: null,
        }),
        expect.objectContaining({ type: 'action.created' }),
        expect.objectContaining({ type: 'action.submitted' }),
        expect.objectContaining({
          type: 'action.resolved',
          paymentStatusBefore: 'AUTHORIZED',
          paymentStatusAfter: 'SUCCEEDED',
          paymentActionId: expect.any(String),
        }),
      ]);
      const events = await prisma.merchantEvent.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true },
      });
      expect(events.map((event) => event.type)).toEqual([
        'payment.authorized',
        'payment.capture_failed',
        'payment.succeeded',
      ]);

      const inspect = await runCli(
        app,
        'payment:inspect',
        '--payment',
        payment.id,
      );
      expect(inspect.out).toContain('capture=MANUAL');
      expect(inspect.out).toContain('Captures and voids:');
      expect(inspect.out).toMatch(
        /A2 \S+ {2}CAPTURE SUCCEEDED {2}amount=300000/,
      );
      expect(inspect.out).toMatch(/action\.resolved\s+attempt #1\s+action A2/);
    });

    it('notifies a void as payment.canceled and reports authorizations in ops:status', async () => {
      const voided = await authorized('pay-1');
      await authorized('pay-2');
      await voidIt(voided.id, 'void-1').expect(202);
      await drainOutbox(app, prisma);

      const types = (
        await prisma.merchantEvent.findMany({
          where: { paymentId: voided.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      ).map((event) => event.type);
      expect(types).toEqual(['payment.authorized', 'payment.canceled']);
      const status = await runCli(app, 'ops:status');
      expect(status.out).toMatch(/Authorized, awaiting capture:\s+1/);
      const metrics = await runCli(app, 'ops:metrics');
      expect(metrics.out).toContain(
        'payguard_payment_actions{type="VOID",status="SUCCEEDED"} 1',
      );
    });
  });

  describe('database guarantees', () => {
    const insertAction = (
      paymentId: string,
      attemptId: string,
      type: 'CAPTURE' | 'VOID',
      amount: number | null,
    ) => prisma.$executeRaw`
      INSERT INTO payment_actions (id, merchant_id, payment_id, attempt_id, type, amount,
                                   idempotency_key, request_fingerprint, updated_at)
      VALUES (gen_random_uuid(), ${acme.merchantId}::uuid, ${paymentId}::uuid,
              ${attemptId}::uuid, ${type}::payment_action_type, ${amount}::bigint,
              gen_random_uuid()::text, ${'0'.repeat(64)}, now())`;

    it('refuses actions on anything but an authorized manual payment, and captures above it', async () => {
      const automatic = (await api.create(acme, 'pay-a').expect(202))
        .body as PaymentResponse;
      await drainOutbox(app, prisma);
      const payment = await authorized('pay-m');

      await expect(
        insertAction(automatic.id, automatic.attempts[0].id, 'VOID', null),
      ).rejects.toThrow(
        /payment_actions_match_authorization|authorized payment/,
      );
      await expect(
        insertAction(
          payment.id,
          payment.attempts[0].id,
          'CAPTURE',
          ORDER.amount + 1,
        ),
      ).rejects.toThrow(/authorized payment/);
      await expect(
        insertAction(payment.id, payment.attempts[0].id, 'VOID', 5),
      ).rejects.toThrow(/payment_actions_amount_iff_capture/);
    });

    it('allows only one action in flight per payment', async () => {
      const payment = await authorized();

      await insertAction(payment.id, payment.attempts[0].id, 'VOID', null);
      await expect(
        insertAction(payment.id, payment.attempts[0].id, 'CAPTURE', 1),
      ).rejects.toThrow(/payment_actions_one_pending_per_payment/);
    });
  });
});
