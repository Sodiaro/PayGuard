import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { OutboxWorker } from '../../src/payments/processing/outbox-worker.js';

// Time is moved by editing timestamps in the test database, so tests never sleep.
export async function makeJobsDue(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`
    UPDATE outbox_jobs SET available_at = now() - interval '1 second' WHERE status = 'QUEUED'`;
}

export async function expireLeases(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`
    UPDATE outbox_jobs SET locked_until = now() - interval '1 second' WHERE status = 'PROCESSING'`;
}

export async function ageAttempts(
  prisma: PrismaService,
  seconds: number,
): Promise<void> {
  await prisma.$executeRaw`
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
