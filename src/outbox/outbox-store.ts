import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/environment.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  OutboxErrorCategory,
  OutboxJobStatus,
  OutboxJobType,
  PaymentAttemptStatus,
} from '../generated/prisma/enums.js';
import { backoffSeconds } from './backoff.js';

export interface ClaimedJob {
  id: string;
  type: OutboxJobType;
  paymentId: string;
  attemptId: string;
  runCount: number;
  leaseToken: string;
  requestId: string | null;
  // The previous claim's lease expired without the job finishing, i.e. a worker died or stalled.
  reclaimed: boolean;
}

export interface EnqueueJob {
  type: OutboxJobType;
  paymentId: string;
  attemptId: string;
  delaySeconds?: number;
  requestId?: string | null;
}

export type RescheduleOutcome = 'rescheduled' | 'dead' | 'lease_lost';

export interface OutboxStats {
  jobs: { type: OutboxJobType; status: OutboxJobStatus; count: number }[];
  pendingErrors: { lastError: OutboxErrorCategory; count: number }[];
  deadJobs: number;
  expiredLeases: number;
  oldestDueJobAgeSeconds: number | null;
  reconciliationLookups: number;
  unresolvedAttempts: number;
  oldestUnresolvedAttemptAgeSeconds: number | null;
}

type Db = Prisma.TransactionClient;

const STALE_SWEEP_BATCH = 100;

@Injectable()
export class OutboxStore {
  private readonly leaseSeconds: number;
  private readonly maxRuns: number;
  private readonly backoffMaxSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.leaseSeconds = config.get('OUTBOX_LEASE_SECONDS', { infer: true });
    this.maxRuns = config.get('OUTBOX_MAX_RUNS', { infer: true });
    this.backoffMaxSeconds = config.get('OUTBOX_BACKOFF_MAX_SECONDS', {
      infer: true,
    });
  }

  // A no-op when the attempt already has a job of this type: re-enqueueing never duplicates work.
  async enqueue(db: Db, job: EnqueueJob): Promise<void> {
    await db.outboxJob.createMany({
      data: {
        type: job.type,
        paymentId: job.paymentId,
        attemptId: job.attemptId,
        availableAt: new Date(Date.now() + (job.delaySeconds ?? 0) * 1000),
        requestId: job.requestId ?? null,
      },
      skipDuplicates: true,
    });
  }

  // SKIP LOCKED lets concurrent workers claim disjoint jobs; the fresh lease token fences every
  // later update, so a worker whose lease expired cannot complete a job someone else now owns.
  async claim(workerId: string, limit: number): Promise<ClaimedJob[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        type: OutboxJobType;
        payment_id: string;
        attempt_id: string;
        run_count: number;
        lease_token: string;
        request_id: string | null;
        reclaimed: boolean;
      }[]
    >`
      WITH due AS (
        SELECT id, status AS previous_status
        FROM outbox_jobs
        WHERE (status = 'QUEUED' AND available_at <= now())
           OR (status = 'PROCESSING' AND locked_until <= now())
        ORDER BY available_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_jobs AS job
      SET status = 'PROCESSING',
          locked_by = ${workerId},
          lease_token = gen_random_uuid(),
          locked_until = now() + ${this.leaseSeconds} * interval '1 second',
          run_count = job.run_count + 1,
          last_error = CASE
            WHEN due.previous_status = 'PROCESSING' THEN 'LEASE_EXPIRED'::outbox_error_category
            ELSE job.last_error
          END,
          updated_at = now()
      FROM due
      WHERE job.id = due.id
      RETURNING job.id, job.type, job.payment_id, job.attempt_id, job.run_count,
                job.lease_token, job.request_id,
                due.previous_status = 'PROCESSING' AS reclaimed`;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      paymentId: row.payment_id,
      attemptId: row.attempt_id,
      runCount: row.run_count,
      leaseToken: row.lease_token,
      requestId: row.request_id,
      reclaimed: row.reclaimed,
    }));
  }

  async complete(db: Db, job: ClaimedJob): Promise<boolean> {
    const result = await db.outboxJob.updateMany({
      where: {
        id: job.id,
        leaseToken: job.leaseToken,
        status: OutboxJobStatus.PROCESSING,
      },
      data: {
        status: OutboxJobStatus.COMPLETED,
        completedAt: new Date(),
        lockedBy: null,
        leaseToken: null,
        lockedUntil: null,
      },
    });
    return result.count === 1;
  }

  // Puts the job back with backoff, or marks it DEAD once it has used its runs. DEAD jobs stay in
  // the table for investigation and are only revived by an operator.
  async reschedule(
    db: Db,
    job: ClaimedJob,
    category: OutboxErrorCategory,
    delaySeconds = backoffSeconds(job.runCount, this.backoffMaxSeconds),
  ): Promise<RescheduleOutcome> {
    const dead = job.runCount >= this.maxRuns;
    const result = await db.outboxJob.updateMany({
      where: {
        id: job.id,
        leaseToken: job.leaseToken,
        status: OutboxJobStatus.PROCESSING,
      },
      data: {
        status: dead ? OutboxJobStatus.DEAD : OutboxJobStatus.QUEUED,
        availableAt: new Date(Date.now() + delaySeconds * 1000),
        lastError: category,
        lockedBy: null,
        leaseToken: null,
        lockedUntil: null,
      },
    });
    if (result.count === 0) return 'lease_lost';
    return dead ? 'dead' : 'rescheduled';
  }

  // Safety net for attempts left PENDING without live work, such as attempts created before the
  // outbox existed or whose processing job died. Attempts that already have a reconciliation job,
  // including a DEAD one, are left alone so dead work stays visible instead of looping.
  async enqueueStaleReconciliations(olderThanSeconds: number): Promise<number> {
    const stale = await this.prisma.$queryRaw<
      { attempt_id: string; payment_id: string }[]
    >`
      SELECT attempt.id AS attempt_id, attempt.payment_id
      FROM payment_attempts AS attempt
      WHERE attempt.status = ${PaymentAttemptStatus.PENDING}::payment_attempt_status
        AND attempt.created_at < now() - ${olderThanSeconds} * interval '1 second'
        AND NOT EXISTS (
          SELECT 1 FROM outbox_jobs AS job
          WHERE job.attempt_id = attempt.id
            AND (job.status IN ('QUEUED', 'PROCESSING') OR job.type = 'RECONCILE_ATTEMPT')
        )
      ORDER BY attempt.created_at
      LIMIT ${STALE_SWEEP_BATCH}`;
    if (stale.length === 0) return 0;

    const created = await this.prisma.outboxJob.createMany({
      data: stale.map((row) => ({
        type: OutboxJobType.RECONCILE_ATTEMPT,
        paymentId: row.payment_id,
        attemptId: row.attempt_id,
      })),
      skipDuplicates: true,
    });
    return created.count;
  }

  async backlogSnapshot(stalledAfterSeconds: number): Promise<{
    oldestDueJobAgeSeconds: number | null;
    stalledLeases: number;
    deadJobs: number;
  }> {
    const [row] = await this.prisma.$queryRaw<
      {
        oldest_due_job_age_seconds: number | null;
        stalled_leases: number;
        dead_jobs: number;
      }[]
    >`
      SELECT
        (SELECT floor(extract(epoch FROM now() - min(available_at)))::int FROM outbox_jobs
          WHERE status = 'QUEUED' AND available_at <= now()) AS oldest_due_job_age_seconds,
        (SELECT count(*)::int FROM outbox_jobs
          WHERE status = 'PROCESSING'
            AND locked_until <= now() - ${stalledAfterSeconds} * interval '1 second') AS stalled_leases,
        (SELECT count(*)::int FROM outbox_jobs WHERE status = 'DEAD') AS dead_jobs`;
    return {
      oldestDueJobAgeSeconds: row.oldest_due_job_age_seconds,
      stalledLeases: row.stalled_leases,
      deadJobs: row.dead_jobs,
    };
  }

  async requeueDead(jobId: string): Promise<boolean> {
    const result = await this.prisma.outboxJob.updateMany({
      where: { id: jobId, status: OutboxJobStatus.DEAD },
      data: {
        status: OutboxJobStatus.QUEUED,
        runCount: 0,
        availableAt: new Date(),
      },
    });
    return result.count === 1;
  }

  async listDead(limit: number) {
    return this.prisma.outboxJob.findMany({
      where: { status: OutboxJobStatus.DEAD },
      select: {
        id: true,
        type: true,
        paymentId: true,
        attemptId: true,
        runCount: true,
        lastError: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  }

  async stats(): Promise<OutboxStats> {
    const [jobs, pendingErrors, [timing]] = await Promise.all([
      this.prisma.outboxJob.groupBy({
        by: ['type', 'status'],
        _count: { _all: true },
        orderBy: [{ type: 'asc' }, { status: 'asc' }],
      }),
      this.prisma.outboxJob.groupBy({
        by: ['lastError'],
        where: {
          status: { not: OutboxJobStatus.COMPLETED },
          lastError: { not: null },
        },
        _count: { _all: true },
        orderBy: { lastError: 'asc' },
      }),
      this.prisma.$queryRaw<
        {
          dead_jobs: number;
          expired_leases: number;
          oldest_due_job_age_seconds: number | null;
          reconciliation_lookups: number;
          unresolved_attempts: number;
          oldest_unresolved_attempt_age_seconds: number | null;
        }[]
      >`
        SELECT
          (SELECT count(*)::int FROM outbox_jobs WHERE status = 'DEAD') AS dead_jobs,
          (SELECT count(*)::int FROM outbox_jobs
            WHERE status = 'PROCESSING' AND locked_until <= now()) AS expired_leases,
          (SELECT floor(extract(epoch FROM now() - min(available_at)))::int FROM outbox_jobs
            WHERE status = 'QUEUED' AND available_at <= now()) AS oldest_due_job_age_seconds,
          (SELECT coalesce(sum(run_count), 0)::int FROM outbox_jobs
            WHERE type = 'RECONCILE_ATTEMPT') AS reconciliation_lookups,
          (SELECT count(*)::int FROM payment_attempts WHERE status = 'PENDING') AS unresolved_attempts,
          (SELECT floor(extract(epoch FROM now() - min(created_at)))::int FROM payment_attempts
            WHERE status = 'PENDING') AS oldest_unresolved_attempt_age_seconds`,
    ]);

    return {
      jobs: jobs.map((row) => ({
        type: row.type,
        status: row.status,
        count: row._count._all,
      })),
      pendingErrors: pendingErrors.map((row) => ({
        lastError: row.lastError!,
        count: row._count._all,
      })),
      deadJobs: timing.dead_jobs,
      expiredLeases: timing.expired_leases,
      oldestDueJobAgeSeconds: timing.oldest_due_job_age_seconds,
      reconciliationLookups: timing.reconciliation_lookups,
      unresolvedAttempts: timing.unresolved_attempts,
      oldestUnresolvedAttemptAgeSeconds:
        timing.oldest_unresolved_attempt_age_seconds,
    };
  }
}
