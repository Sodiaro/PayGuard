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
import { PrismaService } from '../src/database/prisma.service.js';
import { OutboxStore } from '../src/outbox/outbox-store.js';
import type { PaymentResponse } from '../src/payments/payment.responses.js';
import { AttemptJobProcessor } from '../src/payments/processing/attempt-job-processor.js';
import { OutboxWorker } from '../src/payments/processing/outbox-worker.js';
import { SimulatorOutcome } from '../src/payments/providers/simulated-payment-provider.js';
import { runCli, TEST_OPERATOR } from './support/admin-cli.js';
import { failWritesTo } from './support/db-faults.js';
import { drainOutbox, expireLeases, makeJobsDue } from './support/outbox.js';
import { paymentsApi, type Merchant } from './support/payments-api.js';
import { ScriptedProvider } from './support/scripted-provider.js';
import {
  createTestApp,
  operatorOf,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { ownerDatabase, resetDatabase } from './support/test-database.js';
import {
  eventFor,
  testWebhookSecret,
  webhooksApi,
} from './support/webhooks.js';

const IDEMPOTENCY_KEY = 'idem-4f9c2e71-history-test';

describe('Payment lifecycle history and investigation (PostgreSQL)', () => {
  const provider = new ScriptedProvider();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let api: ReturnType<typeof paymentsApi>;
  let webhooks: ReturnType<typeof webhooksApi>;
  let worker: OutboxWorker;
  let acme: Merchant;

  beforeAll(async () => {
    app = await createTestApp({ provider });
    prisma = prismaOf(app);
    api = paymentsApi(app);
    webhooks = webhooksApi(app);
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

  const create = async (merchant = acme, key = IDEMPOTENCY_KEY) => {
    const response = await api.create(merchant, key).expect(202);
    return {
      payment: response.body as PaymentResponse,
      requestId: response.headers['x-request-id'],
    };
  };

  // Submitted, answer lost: a delayed lookup is queued.
  const createAmbiguous = async (outcome = SimulatorOutcome.Succeeded) => {
    provider.willProcessThenTimeOut(outcome);
    const { payment } = await create();
    await worker.processDueJobs();
    return payment;
  };

  const reconcileOnce = async () => {
    await makeJobsDue(prisma);
    return worker.processDueJobs();
  };

  const history = (paymentId: string) =>
    prisma.paymentEvent.findMany({
      where: { paymentId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const types = async (paymentId: string) =>
    (await history(paymentId)).map((event) => event.type);

  describe('history', () => {
    it('records each step of a payment with its source, transition and correlation ID', async () => {
      const { payment, requestId } = await create();
      await drainOutbox(app, prisma);

      const events = await history(payment.id);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'payment.created',
          source: 'MERCHANT',
          paymentStatusBefore: null,
          paymentStatusAfter: 'PENDING',
          attemptStatusAfter: 'PENDING',
          requestId,
        }),
        expect.objectContaining({
          type: 'attempt.submitted',
          source: 'WORKER',
          requestId,
        }),
        expect.objectContaining({
          type: 'attempt.resolved',
          source: 'PROVIDER_RESPONSE',
          attemptStatusBefore: 'PENDING',
          attemptStatusAfter: 'SUCCEEDED',
          paymentStatusBefore: 'PENDING',
          paymentStatusAfter: 'SUCCEEDED',
          outboxJobId: expect.any(String) as unknown as string,
          requestId,
          details: {
            providerReference: expect.stringMatching(
              /^sim_/,
            ) as unknown as string,
            failureCode: null,
          },
        }),
      ]);
      expect(
        events.every((event) => event.attemptId === payment.attempts[0].id),
      ).toBe(true);
    });

    it('records an ambiguous outcome as unknown, deferrals while lookups are inconclusive, and the lookup that resolved it', async () => {
      const payment = await createAmbiguous(SimulatorOutcome.Declined);
      provider.willLookup(
        { status: 'processing' },
        new Error('lookup endpoint returned 502'),
      );

      await reconcileOnce();
      await reconcileOnce();
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      await reconcileOnce();

      const events = await history(payment.id);
      expect(events.map((event) => event.type)).toEqual([
        'payment.created',
        'attempt.submitted',
        'attempt.outcome_unknown',
        'reconciliation.deferred',
        'reconciliation.deferred',
        'attempt.resolved',
      ]);
      expect(events[2].details).toEqual({
        reason: 'no_definite_answer',
        category: 'PROVIDER_TIMEOUT',
        lookupDelaySeconds: 60,
      });
      expect(events.slice(3, 5).map((event) => event.details)).toEqual([
        {
          jobType: 'RECONCILE_ATTEMPT',
          category: 'OUTCOME_PROCESSING',
          runCount: 1,
        },
        {
          jobType: 'RECONCILE_ATTEMPT',
          category: 'PROVIDER_ERROR',
          runCount: 2,
        },
      ]);
      expect(events[5]).toMatchObject({
        source: 'PROVIDER_LOOKUP',
        attemptStatusAfter: 'FAILED',
        paymentStatusAfter: 'FAILED',
        details: { failureCode: 'DECLINED' },
      });
    });

    it('records an accepted retry as the payment reopening with a new attempt', async () => {
      provider.willReturn(SimulatorOutcome.Declined);
      const { payment } = await create();
      await drainOutbox(app, prisma);

      await api.retry(acme, payment.id, 'retry-1').expect(202);

      const retried = (await history(payment.id)).find(
        (event) => event.type === 'payment.retry_accepted',
      );
      const current = await api.read(acme, payment.id);
      expect(retried).toMatchObject({
        source: 'MERCHANT',
        attemptId: current.attempts[1].id,
        paymentStatusBefore: 'FAILED',
        paymentStatusAfter: 'PENDING',
        attemptStatusAfter: 'PENDING',
        details: {
          attemptNumber: 2,
          previousFailureCode: 'DECLINED',
          retryRequestId: expect.any(String) as unknown as string,
        },
      });
    });

    it('records webhook outcomes as provider evidence and distrusted webhooks without changing state', async () => {
      const payment = await createAmbiguous();
      const genuine = eventFor(payment, 'payment.succeeded');

      await webhooks
        .deliver({
          ...genuine,
          id: 'evt_mismatch00000001',
          data: { ...genuine.data, amount: 1 },
        })
        .expect(202);
      await worker.processDueJobs();
      await webhooks.deliver(genuine).expect(202);
      await worker.processDueJobs();

      const events = await history(payment.id);
      const notApplied = events.find(
        (event) => event.type === 'webhook.not_applied',
      );
      const resolved = events.find(
        (event) => event.type === 'attempt.resolved',
      );
      expect(notApplied).toMatchObject({
        source: 'PROVIDER_WEBHOOK',
        details: { result: 'DATA_MISMATCH', lookupJob: 'existing' },
      });
      expect(resolved).toMatchObject({
        source: 'PROVIDER_WEBHOOK',
        webhookEventId: expect.any(String) as unknown as string,
        attemptStatusAfter: 'SUCCEEDED',
      });
      expect(notApplied!.createdAt.getTime()).toBeLessThanOrEqual(
        resolved!.createdAt.getTime(),
      );
    });
  });

  describe('contradicting provider answers', () => {
    it('records a submission answer that contradicts a webhook-recorded outcome, and changes nothing', async () => {
      const { payment } = await create();
      const held = provider.hold();
      const submitting = worker.processDueJobs();
      await held.entered;

      await webhooks.deliver(eventFor(payment, 'payment.declined')).expect(202);
      await worker.processDueJobs();
      held.release();
      await submitting;

      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
      });
      const conflict = (await history(payment.id)).find(
        (event) => event.type === 'attempt.result_conflict',
      );
      expect(conflict).toMatchObject({
        source: 'PROVIDER_RESPONSE',
        attemptStatusBefore: null,
        attemptStatusAfter: null,
        details: {
          reported: { status: 'SUCCEEDED', failureCode: null },
          recorded: { status: 'FAILED', failureCode: 'DECLINED' },
        },
      });

      const status = await runCli(app, 'ops:status');
      expect(status.out).toMatch(/Contradicting provider answers: 1/);
      const metrics = await runCli(app, 'ops:metrics');
      expect(metrics.out).toContain(
        'payguard_payment_attempt_result_conflicts 1',
      );
    });

    it('records nothing extra for a late answer that agrees with the recorded outcome', async () => {
      const { payment } = await create();
      const held = provider.hold();
      const submitting = worker.processDueJobs();
      await held.entered;

      await webhooks
        .deliver(eventFor(payment, 'payment.succeeded'))
        .expect(202);
      await worker.processDueJobs();
      held.release();
      await submitting;

      await expect(types(payment.id)).resolves.toEqual([
        'payment.created',
        'attempt.submitted',
        'attempt.resolved',
      ]);
      await expect(
        runCli(app, 'ops:status').then((result) => result.out),
      ).resolves.toMatch(/Contradicting provider answers: 0/);
    });
  });

  describe('exhausted reconciliation', () => {
    it('never presents exhausted lookups as a resolution, and returns through the lookup after a requeue', async () => {
      const payment = await createAmbiguous();
      provider.willLookup(
        ...Array.from({ length: 10 }, () => ({
          status: 'unavailable' as const,
        })),
      );
      for (let run = 0; run < 10; run++) await reconcileOnce();

      const exhausted = await types(payment.id);
      expect(exhausted).not.toContain('attempt.resolved');
      expect(exhausted.at(-1)).toBe('outbox_job.dead');
      await expect(api.read(acme, payment.id)).resolves.toMatchObject({
        status: 'PENDING',
      });

      const unresolved = await runCli(app, 'payments:unresolved');
      expect(unresolved.out).toContain(`payment=${payment.id}`);
      expect(unresolved.out).toMatch(
        /state=reconciliation_exhausted\s+lastError=PROVIDER_UNAVAILABLE.*OPERATOR ACTION NEEDED/,
      );
      const status = await runCli(app, 'ops:status');
      expect(status.out).toMatch(/Awaiting an operator:\s+1/);

      const dead = await prisma.outboxJob.findFirstOrThrow({
        where: { type: 'RECONCILE_ATTEMPT' },
      });
      await expect(
        runCli(app, 'outbox:requeue', '--job', dead.id),
      ).resolves.toMatchObject({ code: 0 });
      await reconcileOnce();

      const events = await history(payment.id);
      expect(events.at(-2)).toMatchObject({
        type: 'outbox_job.requeued',
        source: 'OPERATOR',
        actor: TEST_OPERATOR,
        outboxJobId: dead.id,
      });
      expect(events.at(-1)).toMatchObject({
        type: 'attempt.resolved',
        source: 'PROVIDER_LOOKUP',
      });
      await expect(
        ownerDatabase().operatorAuditEvent.count({
          where: { action: 'outbox_job.requeued', targetId: dead.id },
        }),
      ).resolves.toBe(1);
      await expect(runCli(app, 'payments:unresolved')).resolves.toMatchObject({
        out: 'No unresolved attempts.',
      });
    });

    it('requeues and audits a dead job once when operators race', async () => {
      const payment = await createAmbiguous();
      provider.willLookup(
        ...Array.from({ length: 10 }, () => ({
          status: 'processing' as const,
        })),
      );
      for (let run = 0; run < 10; run++) await reconcileOnce();
      const dead = await prisma.outboxJob.findFirstOrThrow({
        where: { status: 'DEAD' },
      });

      // Forces the race: both requeues read the job as DEAD, then queue on its row lock.
      let release!: () => void;
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => (locked = resolve));
      const blocker = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM outbox_jobs WHERE id = ${dead.id}::uuid FOR UPDATE`;
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 20_000 },
      );
      await lockHeld;

      // Requeueing is an operator action, run with the operator role as the CLI would.
      const store = operatorOf(app).get(OutboxStore);
      const racing = Promise.all([
        store.requeueDead(dead.id, 'alice'),
        store.requeueDead(dead.id, 'bob'),
      ]);
      // pg_locks, unlike pg_stat_activity, shows other roles' waits to an unprivileged role.
      for (let waiting = 0; waiting < 2;) {
        [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks WHERE NOT granted`;
      }
      release();
      await blocker;
      const results = await racing;

      expect(results.filter(Boolean)).toHaveLength(1);
      await expect(
        ownerDatabase().operatorAuditEvent.count({
          where: { action: 'outbox_job.requeued' },
        }),
      ).resolves.toBe(1);
      expect(
        (await types(payment.id)).filter(
          (type) => type === 'outbox_job.requeued',
        ),
      ).toHaveLength(1);
    });
  });

  describe('integrity', () => {
    it('records a resolution once when a stalled lookup resumes after another worker took over', async () => {
      const payment = await createAmbiguous();
      await makeJobsDue(prisma);
      const [stalled] = await app.get(OutboxStore).claim('stalled-worker', 10);
      await expireLeases(prisma);
      await worker.processDueJobs();

      await app.get(AttemptJobProcessor).handle(stalled);

      const recorded = await types(payment.id);
      expect(
        recorded.filter((type) => type === 'attempt.resolved'),
      ).toHaveLength(1);
    });

    it('rolls back the state change when its history cannot be written, and retries it', async () => {
      const { payment } = await create();
      const restore = await failWritesTo('payment_events', 'INSERT');
      try {
        await worker.processDueJobs();
      } finally {
        await restore();
      }

      // Marking the attempt submitted failed with its history, so nothing was sent.
      expect(provider.submissions).toHaveLength(0);
      await expect(
        prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: payment.attempts[0].id },
        }),
      ).resolves.toMatchObject({ status: 'PENDING', submittedAt: null });
      await expect(types(payment.id)).resolves.toEqual(['payment.created']);

      await drainOutbox(app, prisma);
      await expect(types(payment.id)).resolves.toEqual([
        'payment.created',
        'attempt.submitted',
        'attempt.resolved',
      ]);
    });

    it('creates no payment, and no history, when the creation transaction fails', async () => {
      const restore = await failWritesTo('payment_events', 'INSERT');
      try {
        await api.create(acme, IDEMPOTENCY_KEY).expect(500);
      } finally {
        await restore();
      }

      await expect(prisma.payment.count()).resolves.toBe(0);
      await expect(prisma.outboxJob.count()).resolves.toBe(0);
      await expect(prisma.paymentEvent.count()).resolves.toBe(0);
    });

    it('rejects updates and deletes of history rows', async () => {
      const { payment } = await create();
      const [event] = await history(payment.id);

      // The application and operator roles hold no UPDATE or DELETE privilege on history at all;
      // the trigger stops the owner, which does.
      for (const role of [prisma, operatorOf(app).get(PrismaService)]) {
        await expect(
          role.$executeRaw`UPDATE payment_events SET type = 'payment.forged' WHERE id = ${event.id}::uuid`,
        ).rejects.toThrow(/permission denied/);
        await expect(
          role.$executeRaw`DELETE FROM payment_events WHERE id = ${event.id}::uuid`,
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        ownerDatabase()
          .$executeRaw`UPDATE payment_events SET type = 'payment.forged' WHERE id = ${event.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        ownerDatabase()
          .$executeRaw`DELETE FROM payment_events WHERE id = ${event.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(history(payment.id)).resolves.toEqual([event]);
    });

    it('keeps operator actors and provider sources apart at the database level', async () => {
      const { payment } = await create();

      await expect(
        prisma.$executeRaw`
          INSERT INTO payment_events (id, payment_id, type, source, actor)
          VALUES (gen_random_uuid(), ${payment.id}::uuid, 'attempt.resolved', 'PROVIDER_LOOKUP', 'mallory')`,
      ).rejects.toThrow(/payment_events_actor_iff_operator/);
      await expect(
        prisma.$executeRaw`
          INSERT INTO payment_events (id, payment_id, type, source)
          VALUES (gen_random_uuid(), ${payment.id}::uuid, 'outbox_job.requeued', 'OPERATOR')`,
      ).rejects.toThrow(/payment_events_actor_iff_operator/);
    });
  });

  describe('investigation commands', () => {
    it('lists only unresolved attempts, oldest first, optionally for one merchant', async () => {
      const globex = await provisionMerchant(app, 'globex');
      const ours = await createAmbiguous();
      // Settled through its own submission only; the delayed lookups stay queued.
      provider.willReturn(SimulatorOutcome.Succeeded);
      await create(acme, 'settled-key');
      await worker.processDueJobs();
      provider.willProcessThenTimeOut(SimulatorOutcome.Succeeded);
      const theirs = (await create(globex, 'theirs')).payment;
      await worker.processDueJobs();

      const all = await runCli(app, 'payments:unresolved');
      const onlyGlobex = await runCli(
        app,
        'payments:unresolved',
        '--merchant',
        'globex',
      );

      expect(all.out.indexOf(ours.id)).toBeLessThan(all.out.indexOf(theirs.id));
      expect(all.out).toMatch(/2 shown, 0 need an operator/);
      expect(onlyGlobex.out).toContain(theirs.id);
      expect(onlyGlobex.out).not.toContain(ours.id);
    });

    it('shows a payment with its attempts, jobs, webhooks, history and verdict, and nothing secret', async () => {
      const payment = await createAmbiguous();
      await webhooks
        .deliver(eventFor(payment, 'payment.succeeded'))
        .expect(202);
      await worker.processDueJobs();

      const result = await runCli(
        app,
        'payment:inspect',
        '--payment',
        payment.id,
      );

      expect(result.code).toBe(0);
      expect(result.out).toContain(
        `Payment ${payment.id}  SUCCEEDED  500000 NGN`,
      );
      expect(result.out).toMatch(/job \S+\s+PROCESS_ATTEMPT COMPLETED/);
      expect(result.out).toMatch(
        /payment\.succeeded\s+attempt #1\s+PROCESSED APPLIED/,
      );
      expect(result.out).toMatch(
        /PROVIDER_WEBHOOK\s+attempt\.resolved\s+attempt #1\s+payment PENDING -> SUCCEEDED/,
      );
      expect(result.out).toContain(
        'Verdict: SUCCEEDED; no attempt is awaiting an outcome.',
      );
      for (const secret of [
        acme.apiKey,
        testWebhookSecret(),
        IDEMPOTENCY_KEY,
      ]) {
        expect(result.out).not.toContain(secret);
      }
      const fingerprint = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { requestFingerprint: true },
      });
      expect(result.out).not.toContain(fingerprint.requestFingerprint);
    });

    it('explains why an unresolved payment is not progressing', async () => {
      const payment = await createAmbiguous();
      provider.willLookup({ status: 'processing' });
      await reconcileOnce();

      const result = await runCli(
        app,
        'payment:inspect',
        '--payment',
        payment.id,
      );

      expect(result.out).toMatch(
        /unresolved: state=lookup_retrying\s+lastError=OUTCOME_PROCESSING\s+next=in \d+s/,
      );
      expect(result.out).toContain(
        'Verdict: unresolved; attempt #1 is lookup_retrying.',
      );
    });

    it('rejects an unknown or malformed payment ID', async () => {
      await expect(
        runCli(
          app,
          'payment:inspect',
          '--payment',
          '019a0000-0000-7000-8000-000000000000',
        ),
      ).resolves.toMatchObject({
        code: 1,
        err: 'Error: No payment with id 019a0000-0000-7000-8000-000000000000',
      });
      await expect(
        runCli(app, 'payment:inspect', '--payment', "x' OR 1=1"),
      ).resolves.toMatchObject({ code: 1 });
    });
  });

  it('keeps history out of the merchant API', async () => {
    const { payment } = await create();
    await drainOutbox(app, prisma);
    const globex = await provisionMerchant(app, 'globex');

    const response = await api.get(acme, payment.id).expect(200);
    expect(Object.keys(response.body as object).sort()).toEqual([
      'amount',
      'attempts',
      'createdAt',
      'currency',
      'failureCode',
      'id',
      'reference',
      'status',
      'updatedAt',
    ]);
    await api.get(globex, payment.id).expect(404);
    await request(app.getHttpServer())
      .get(`/v1/payments/${payment.id}/events`)
      .set('Authorization', `Bearer ${acme.apiKey}`)
      .expect(404);
  });
});
