import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { App } from 'supertest/types.js';

// A functional concurrency soak, not a benchmark: it drives real HTTP clients and real worker
// processes against one PostgreSQL test database, then checks that no invariant broke. Its
// throughput and latency figures describe this machine and this run only.
//
//   npm run test:soak                                 defaults below
//   SOAK_DURATION_SECONDS=120 SOAK_CLIENTS=16 SOAK_WORKERS=4 npm run test:soak
function setting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}
const SETTINGS = {
  durationSeconds: setting('SOAK_DURATION_SECONDS', 30, 5, 3600),
  clients: setting('SOAK_CLIENTS', 8, 1, 64),
  workers: setting('SOAK_WORKERS', 3, 1, 8),
  drainSeconds: setting('SOAK_DRAIN_SECONDS', 90, 35, 1800),
  seed: setting('SOAK_SEED', 1, 0, 2 ** 31 - 1),
  killWorker: process.env.SOAK_KILL_WORKER !== 'false',
};

// Every submission's answer is lost and every lookup or webhook says "declined", so each attempt
// goes through reconciliation, races webhooks, fails, and is retried up to the attempt limit.
Object.assign(process.env, {
  PAYMENT_SIMULATOR_OUTCOME: 'DECLINED',
  PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: 'true',
  RECONCILIATION_DELAY_SECONDS: '1',
  OUTBOX_POLL_INTERVAL_MS: '100',
  OUTBOX_BACKOFF_MAX_SECONDS: '2',
  OUTBOX_LEASE_SECONDS: '30',
  RATE_LIMIT_IP_PER_MINUTE: '100000',
  RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE: '10000',
});
const { MAX_ATTEMPTS_PER_PAYMENT } =
  await import('../src/payments/payment-lifecycle.js');
const {
  signSimulatedWebhook,
  simulatedWebhookEvent,
  SIMULATOR_SIGNATURE_HEADER,
} = await import('../src/payments/providers/simulated-webhooks.js');
const { outboxDiagnostics } = await import('./support/outbox.js');
const { createTestApp, prismaOf, provisionMerchant } =
  await import('./support/test-app.js');
const { resetDatabase } = await import('./support/test-database.js');
const { testWebhookSecret } = await import('./support/webhooks.js');
const { requireTestDatabaseUrl } = await import('./global-setup.js');

type Operation = 'create' | 'webhook' | 'retry' | 'read';

interface PaymentView {
  id: string;
  amount: number;
  currency: string;
  status: string;
  attempts: { id: string; createdAt: string }[];
}

// Deterministic choices per client (mulberry32); timing still varies between runs.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}

describe('Concurrency soak (PostgreSQL, worker processes)', () => {
  const runDir = join(
    'soak-results',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  let app: INestApplication<App>;
  let baseUrl: string;
  const workers: ChildProcess[] = [];

  const latencies = new Map<Operation, number[]>();
  const statuses = new Map<string, number>();
  const failures: string[] = [];
  const keysSent = new Set<string>();
  const eventsAcknowledged = new Set<string>();

  function startWorker(index: number): ChildProcess {
    const child = spawn(process.execPath, ['dist/worker.js'], {
      env: { ...process.env, DATABASE_URL: requireTestDatabaseUrl() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(join(runDir, `worker-${index}.log`));
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    workers.push(child);
    return child;
  }

  async function call(
    operation: Operation,
    path: string,
    init: RequestInit,
    expected: number[],
  ): Promise<{ status: number; body: unknown }> {
    const startedAt = performance.now();
    let status = 0;
    let body: unknown = null;
    try {
      const response = await fetch(`${baseUrl}${path}`, init);
      status = response.status;
      body = await response.json().catch(() => null);
    } catch (error) {
      failures.push(`${operation} ${path}: ${(error as Error).message}`);
    }
    const samples = latencies.get(operation) ?? [];
    samples.push(performance.now() - startedAt);
    latencies.set(operation, samples);
    statuses.set(
      `${operation} ${status}`,
      (statuses.get(`${operation} ${status}`) ?? 0) + 1,
    );
    if (status !== 0 && !expected.includes(status)) {
      failures.push(`${operation} ${path}: unexpected HTTP ${status}`);
    }
    return { status, body };
  }

  beforeAll(async () => {
    if (!existsSync('dist/worker.js')) {
      throw new Error('dist/worker.js is missing: run npm run build first');
    }
    mkdirSync(runDir, { recursive: true });
    app = await createTestApp();
    await resetDatabase(prismaOf(app));
    await app.listen(0, '127.0.0.1');
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const child of workers) {
      if (child.exitCode === null) child.kill();
    }
    await app?.close();
  });

  it('keeps every payment invariant under concurrent clients, duplicate requests, webhooks, retries and a worker crash', async () => {
    const prisma = prismaOf(app);
    const merchants = [
      await provisionMerchant(app, 'soak-a'),
      await provisionMerchant(app, 'soak-b'),
    ];
    for (let i = 0; i < SETTINGS.workers; i++) startWorker(i);

    const startedAt = Date.now();
    const deadline = startedAt + SETTINGS.durationSeconds * 1000;
    let killed: string | null = null;
    const crash = SETTINGS.killWorker
      ? setTimeout(
          () => {
            const victim = workers[0];
            victim.kill('SIGKILL');
            killed = `worker 0 (pid ${victim.pid}) killed at ${new Date().toISOString()}`;
            startWorker(SETTINGS.workers);
          },
          (SETTINGS.durationSeconds * 1000) / 2,
        )
      : null;

    const client = async (index: number) => {
      const merchant = merchants[index % merchants.length];
      const auth = { Authorization: `Bearer ${merchant.apiKey}` };
      const next = random(SETTINGS.seed * 1000 + index);
      const mine: string[] = [];
      let sequence = 0;
      while (Date.now() < deadline) {
        if (mine.length === 0 || next() < 0.35) {
          const key = `soak-${index % merchants.length === 0 ? 'a' : 'b'}-c${index}-${sequence++}`;
          keysSent.add(key);
          const send = () =>
            call(
              'create',
              '/v1/payments',
              {
                method: 'POST',
                headers: {
                  ...auth,
                  'Content-Type': 'application/json',
                  'Idempotency-Key': key,
                },
                body: JSON.stringify({ amount: 1000 + index, currency: 'NGN' }),
              },
              [200, 202],
            );
          const results = await Promise.all(
            next() < 0.2 ? [send(), send()] : [send()],
          );
          const created = results.find(
            (result) => result.status === 202 || result.status === 200,
          );
          if (created?.body) mine.push((created.body as PaymentView).id);
          continue;
        }

        const paymentId = mine[Math.floor(next() * mine.length)];
        const { body } = await call(
          'read',
          `/v1/payments/${paymentId}`,
          { headers: auth },
          [200],
        );
        const payment = body as PaymentView | null;
        if (!payment) continue;
        const latest = payment.attempts.at(-1)!;

        if (payment.status === 'PENDING') {
          const type =
            next() < 0.15 ? 'payment.processing' : 'payment.declined';
          const event = simulatedWebhookEvent(
            {
              attemptId: latest.id,
              amount: payment.amount,
              currency: payment.currency,
            },
            type,
            new Date(latest.createdAt),
          );
          const deliver = async () => {
            const delivery = signSimulatedWebhook(
              testWebhookSecret(),
              event,
              Math.floor(Date.now() / 1000),
            );
            const result = await call(
              'webhook',
              '/v1/webhooks/simulator',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  [SIMULATOR_SIGNATURE_HEADER]: delivery.signature,
                },
                body: delivery.body,
              },
              [200, 202],
            );
            if (result.status === 200 || result.status === 202)
              eventsAcknowledged.add(event.id);
          };
          await Promise.all(
            next() < 0.3 ? [deliver(), deliver()] : [deliver()],
          );
        } else if (
          payment.status === 'FAILED' &&
          payment.attempts.length < MAX_ATTEMPTS_PER_PAYMENT
        ) {
          const retryKey = `retry-${paymentId}-${payment.attempts.length}`;
          const retry = () =>
            call(
              'retry',
              `/v1/payments/${paymentId}/retry`,
              {
                method: 'POST',
                headers: { ...auth, 'Idempotency-Key': retryKey },
              },
              // 409: a concurrent duplicate already moved the payment on.
              [200, 202, 409],
            );
          await Promise.all(next() < 0.25 ? [retry(), retry()] : [retry()]);
        }
      }
    };
    await Promise.all(
      Array.from({ length: SETTINGS.clients }, (_, i) => client(i)),
    );
    const loadEndedAt = Date.now();
    if (crash) clearTimeout(crash);

    // Drain: wait for every attempt to settle and every job to finish, within a bound.
    const drainDeadline = Date.now() + SETTINGS.drainSeconds * 1000;
    const unsettled = async () => ({
      pendingAttempts: await prisma.paymentAttempt.count({
        where: { status: 'PENDING' },
      }),
      liveJobs: await prisma.outboxJob.count({
        where: { status: { in: ['QUEUED', 'PROCESSING'] } },
      }),
    });
    let remaining = await unsettled();
    while (
      (remaining.pendingAttempts > 0 || remaining.liveJobs > 0) &&
      Date.now() < drainDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      remaining = await unsettled();
    }
    const drainedAt = Date.now();

    const violations = {
      paymentStatusDisagreesWithLatestAttempt: await prisma.$queryRaw<
        { id: string }[]
      >`
        SELECT payment.id FROM payments AS payment
        JOIN LATERAL (
          SELECT status FROM payment_attempts WHERE payment_id = payment.id
          ORDER BY attempt_number DESC LIMIT 1
        ) AS latest ON true
        WHERE payment.status::text <> latest.status::text`,
      attemptNumbersNotContiguous: await prisma.$queryRaw<{ id: string }[]>`
        SELECT payment_id AS id FROM payment_attempts GROUP BY payment_id
        HAVING max(attempt_number) <> count(*) OR count(*) > ${MAX_ATTEMPTS_PER_PAYMENT}`,
      resolutionHistoryMismatch: await prisma.$queryRaw<{ id: string }[]>`
        SELECT attempt.id FROM payment_attempts AS attempt
        LEFT JOIN (
          SELECT attempt_id, count(*)::int AS resolved FROM payment_events
          WHERE type = 'attempt.resolved' GROUP BY attempt_id
        ) AS history ON history.attempt_id = attempt.id
        WHERE coalesce(history.resolved, 0) <> CASE WHEN attempt.status = 'PENDING' THEN 0 ELSE 1 END`,
      attemptSubmittedTwice: await prisma.$queryRaw<{ id: string }[]>`
        SELECT attempt_id AS id FROM payment_events WHERE type = 'attempt.submitted'
        GROUP BY attempt_id HAVING count(*) > 1`,
      retryRequestsWithoutAttempt: await prisma.$queryRaw<{ id: string }[]>`
        SELECT payment_id AS id FROM (
          SELECT payment_id, count(*) FILTER (WHERE attempt_number > 1) AS retried
          FROM payment_attempts GROUP BY payment_id
        ) AS attempts
        LEFT JOIN (
          SELECT payment_id AS retried_payment, count(*) AS requests
          FROM payment_retry_requests GROUP BY payment_id
        ) AS requests ON requests.retried_payment = attempts.payment_id
        WHERE attempts.retried <> coalesce(requests.requests, 0)`,
      paymentOwnedByWrongMerchant: await prisma.$queryRaw<{ id: string }[]>`
        SELECT payment.id FROM payments AS payment
        JOIN merchants AS merchant ON merchant.id = payment.merchant_id
        WHERE payment.idempotency_key NOT LIKE merchant.slug || '-%'`,
      deadJobs: await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM outbox_jobs WHERE status = 'DEAD'`,
    };
    const payments = await prisma.payment.count();
    const webhookEvents = await prisma.providerWebhookEvent.count();
    const createdEvents = await prisma.paymentEvent.count({
      where: { type: 'payment.created' },
    });
    const attemptsByStatus = await prisma.paymentAttempt.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const webhookResults = await prisma.providerWebhookEvent.groupBy({
      by: ['result'],
      _count: { _all: true },
    });
    const [{ leaseRecoveries }] = await prisma.$queryRaw<
      { leaseRecoveries: number }[]
    >`SELECT coalesce(sum(lease_recoveries), 0)::int AS "leaseRecoveries" FROM outbox_jobs`;
    const loadSeconds = (loadEndedAt - startedAt) / 1000;
    const requests = [...latencies.values()].reduce(
      (sum, list) => sum + list.length,
      0,
    );

    const summary = {
      settings: SETTINGS,
      workerCrash: killed,
      // Jobs taken over after their worker's lease expired: non-zero when the killed worker was
      // holding work at the time.
      leaseRecoveries,
      loadSeconds,
      drainSeconds: (drainedAt - loadEndedAt) / 1000,
      requests,
      requestsPerSecond: Number((requests / loadSeconds).toFixed(1)),
      latencyMs: Object.fromEntries(
        [...latencies].map(([operation, samples]) => {
          const sorted = [...samples].sort((a, b) => a - b);
          const round = (value: number | null) =>
            value === null ? null : Number(value.toFixed(1));
          return [
            operation,
            {
              count: sorted.length,
              p50: round(percentile(sorted, 50)),
              p95: round(percentile(sorted, 95)),
              p99: round(percentile(sorted, 99)),
              max: round(sorted.at(-1) ?? null),
            },
          ];
        }),
      ),
      statuses: Object.fromEntries(statuses),
      payments,
      distinctKeysSent: keysSent.size,
      attemptsByStatus: Object.fromEntries(
        attemptsByStatus.map((row) => [row.status, row._count._all]),
      ),
      webhookEventsStored: webhookEvents,
      distinctWebhookEventsAcknowledged: eventsAcknowledged.size,
      webhookResults: Object.fromEntries(
        webhookResults.map((row) => [
          row.result ?? 'unprocessed',
          row._count._all,
        ]),
      ),
      unresolvedAfterDrain: remaining,
      violations: Object.fromEntries(
        Object.entries(violations).map(([name, rows]) => [
          name,
          rows.map((row) => row.id),
        ]),
      ),
      failures: failures.slice(0, 50),
      failureCount: failures.length,
    };
    writeFileSync(
      join(runDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    const failed =
      failures.length > 0 ||
      Object.values(violations).some((rows) => rows.length > 0) ||
      remaining.pendingAttempts > 0 ||
      remaining.liveJobs > 0 ||
      payments !== keysSent.size ||
      createdEvents !== payments ||
      webhookEvents !== eventsAcknowledged.size;
    if (failed) {
      writeFileSync(
        join(runDir, 'outbox-diagnostics.txt'),
        await outboxDiagnostics(prisma),
      );
    }
    process.stdout.write(
      `Soak summary (${runDir}):\n${JSON.stringify(summary, null, 2)}\n`,
    );

    expect(summary.failures).toEqual([]);
    expect(summary.violations).toEqual(
      Object.fromEntries(Object.keys(violations).map((name) => [name, []])),
    );
    expect(remaining).toEqual({ pendingAttempts: 0, liveJobs: 0 });
    expect(payments).toBe(keysSent.size);
    expect(createdEvents).toBe(payments);
    expect(webhookEvents).toBe(eventsAcknowledged.size);
  });
});
