import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { OutboxWorker } from '../../src/payments/processing/outbox-worker.js';
import { ownerDatabase } from './test-database.js';

// Time is moved by editing timestamps in the test database, so tests never sleep.
export async function makeJobsDue(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`
    UPDATE outbox_jobs SET available_at = now() - interval '1 second' WHERE status = 'QUEUED'`;
}

export async function expireLeases(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`
    UPDATE outbox_jobs SET locked_until = now() - interval '1 second' WHERE status = 'PROCESSING'`;
}

// Creation times are not writable by the application's role, so the schema owner rewrites them.
export async function ageAttempts(seconds: number): Promise<void> {
  await ownerDatabase().$executeRaw`
    UPDATE payment_attempts SET created_at = created_at - ${seconds} * interval '1 second'`;
}

// Runs the worker until no job is due, making delayed jobs due between rounds.
export async function drainOutbox(
  app: INestApplication,
  prisma: PrismaService,
  maxRounds = 25,
): Promise<number> {
  const worker = app.get(OutboxWorker);
  let handled = 0;
  for (let round = 0; round < maxRounds; round++) {
    await makeJobsDue(prisma);
    const processed = await worker.processDueJobs();
    if (processed === 0) return handled;
    handled += processed;
  }
  throw new Error(`Outbox did not drain within ${maxRounds} rounds`);
}

export async function makeJobDue(
  prisma: PrismaService,
  jobId: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE outbox_jobs SET available_at = now() - interval '1 second' WHERE id = ${jobId}::uuid`;
}

// For failure messages: both clocks and every job's scheduling state. Identifiers, statuses and
// times only, never payloads.
export async function outboxDiagnostics(
  prisma: PrismaService,
): Promise<string> {
  const appNow = new Date();
  const [{ dbNow }] = await prisma.$queryRaw<{ dbNow: Date }[]>`
    SELECT clock_timestamp() AS "dbNow"`;
  const jobs = await prisma.$queryRaw<
    {
      id: string;
      type: string;
      status: string;
      runCount: number;
      availableAt: Date;
      due: boolean;
      lockedBy: string | null;
      lockedUntil: Date | null;
      lastError: string | null;
      webhookEventId: string | null;
    }[]
  >`
    SELECT id, type, status, run_count AS "runCount", available_at AS "availableAt",
           available_at <= clock_timestamp() AS due, locked_by AS "lockedBy",
           locked_until AS "lockedUntil", last_error AS "lastError",
           webhook_event_id AS "webhookEventId"
    FROM outbox_jobs ORDER BY created_at, id`;
  return [
    `database clock ${dbNow.toISOString()}, application clock ${appNow.toISOString()} (application - database = ${appNow.getTime() - dbNow.getTime()} ms)`,
    ...jobs.map(
      (job) =>
        `  ${job.id} ${job.type} ${job.status} runs=${job.runCount} availableAt=${job.availableAt.toISOString()} due=${job.due} lockedBy=${job.lockedBy ?? '-'} lockedUntil=${job.lockedUntil?.toISOString() ?? '-'} lastError=${job.lastError ?? '-'} webhookEvent=${job.webhookEventId ?? '-'}`,
    ),
  ].join('\n');
}

// Runs one worker batch and fails with the outbox's scheduling state if it did not handle the
// expected number of jobs, so a job that was not due explains itself.
export async function processDueJobsExpecting(
  app: INestApplication,
  prisma: PrismaService,
  expected: number,
): Promise<number> {
  const processed = await app.get(OutboxWorker).processDueJobs();
  if (processed !== expected) {
    throw new Error(
      `Expected the worker to handle ${expected} due job(s), it handled ${processed}.\n${await outboxDiagnostics(prisma)}`,
    );
  }
  return processed;
}

export function jobsOf(prisma: PrismaService) {
  return prisma.outboxJob.findMany({
    orderBy: [{ createdAt: 'asc' }, { type: 'asc' }],
    select: {
      id: true,
      type: true,
      status: true,
      runCount: true,
      lastError: true,
      attemptId: true,
      requestId: true,
    },
  });
}
