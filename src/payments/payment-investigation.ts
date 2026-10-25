import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import {
  OutboxJobStatus,
  OutboxJobType,
  PaymentAttemptStatus,
  ProviderWebhookEventResult,
  type OutboxErrorCategory,
} from '../generated/prisma/enums.js';
import { PaymentEventType } from './payment-events.js';

// Why an unresolved attempt is where it is, from its outbox jobs.
export type UnresolvedState =
  // A worker holds one of its jobs right now.
  | 'in_progress'
  | 'awaiting_submission'
  // Submission failed internally (not at the provider) and is retried with backoff.
  | 'submission_retrying'
  | 'awaiting_lookup'
  // Lookups so far were inconclusive or failed; retried with backoff.
  | 'lookup_retrying'
  // Lookups ran out of runs: nothing automatic will happen until an operator acts.
  | 'reconciliation_exhausted'
  // No live job; the stale sweep queues a lookup once the attempt is old enough.
  | 'awaiting_sweep';

export interface JobView {
  type: OutboxJobType;
  status: OutboxJobStatus;
  runCount: number;
  lastError: OutboxErrorCategory | null;
  availableAt: Date;
}

export interface UnresolvedDiagnosis {
  state: UnresolvedState;
  needsOperator: boolean;
  lastError: OutboxErrorCategory | null;
  nextRunAt: Date | null;
}

export function diagnoseUnresolved(
  jobs: readonly JobView[],
): UnresolvedDiagnosis {
  const attemptJobs = jobs.filter(
    (job) => job.type !== OutboxJobType.APPLY_WEBHOOK_EVENT,
  );
  const running = attemptJobs.find(
    (job) => job.status === OutboxJobStatus.PROCESSING,
  );
  if (running) return diagnosis('in_progress', running, false);

  const lookup = attemptJobs.find(
    (job) => job.type === OutboxJobType.RECONCILE_ATTEMPT,
  );
  if (lookup?.status === OutboxJobStatus.DEAD) {
    return diagnosis('reconciliation_exhausted', lookup, true);
  }
  if (lookup?.status === OutboxJobStatus.QUEUED) {
    return diagnosis(
      lookup.runCount > 0 ? 'lookup_retrying' : 'awaiting_lookup',
      lookup,
      false,
    );
  }

  const submission = attemptJobs.find(
    (job) => job.type === OutboxJobType.PROCESS_ATTEMPT,
  );
  if (submission?.status === OutboxJobStatus.QUEUED) {
    return diagnosis(
      submission.runCount > 0 ? 'submission_retrying' : 'awaiting_submission',
      submission,
      false,
    );
  }
  return {
    state: 'awaiting_sweep',
    needsOperator: false,
    lastError: submission?.lastError ?? null,
    nextRunAt: null,
  };
}

function diagnosis(
  state: UnresolvedState,
  job: JobView,
  needsOperator: boolean,
): UnresolvedDiagnosis {
  return {
    state,
    needsOperator,
    lastError: job.lastError,
    nextRunAt: job.status === OutboxJobStatus.QUEUED ? job.availableAt : null,
  };
}

// Webhook results that mean the provider said something PayGuard could not accept.
const DISTRUSTED_WEBHOOK_RESULTS = [
  ProviderWebhookEventResult.OUTCOME_CONFLICT,
  ProviderWebhookEventResult.DATA_MISMATCH,
  ProviderWebhookEventResult.PAYLOAD_CONFLICT,
];

const JOB_FIELDS = {
  id: true,
  type: true,
  status: true,
  runCount: true,
  leaseRecoveries: true,
  lastError: true,
  availableAt: true,
  completedAt: true,
} as const;

// Read-only queries for the operator CLI. Results carry identifiers, statuses, codes and times,
// never idempotency keys, request fingerprints, credentials or provider payloads.
@Injectable()
export class PaymentInvestigator {
  constructor(private readonly prisma: PrismaService) {}

  async unresolved(options: { limit: number; merchantId?: string }) {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: {
        status: PaymentAttemptStatus.PENDING,
        ...(options.merchantId && {
          payment: { merchantId: options.merchantId },
        }),
      },
      orderBy: { createdAt: 'asc' },
      take: options.limit,
      select: {
        id: true,
        attemptNumber: true,
        createdAt: true,
        submittedAt: true,
        payment: {
          select: { id: true, merchant: { select: { slug: true } } },
        },
        outboxJobs: { select: JOB_FIELDS },
      },
    });
    const attemptIds = attempts.map((attempt) => attempt.id);
    const [webhookConflicts, resultConflicts] = await Promise.all([
      this.prisma.providerWebhookEvent.groupBy({
        by: ['attemptId'],
        where: {
          attemptId: { in: attemptIds },
          result: { in: DISTRUSTED_WEBHOOK_RESULTS },
        },
        _count: { _all: true },
      }),
      this.prisma.paymentEvent.groupBy({
        by: ['attemptId'],
        where: {
          attemptId: { in: attemptIds },
          type: PaymentEventType.RESULT_CONFLICT,
        },
        _count: { _all: true },
      }),
    ]);
    const countFor = (
      rows: { attemptId: string | null; _count: { _all: number } }[],
      attemptId: string,
    ) => rows.find((row) => row.attemptId === attemptId)?._count._all ?? 0;

    return attempts.map((attempt) => ({
      paymentId: attempt.payment.id,
      merchantSlug: attempt.payment.merchant.slug,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      createdAt: attempt.createdAt,
      submitted: attempt.submittedAt !== null,
      diagnosis: diagnoseUnresolved(attempt.outboxJobs),
      webhookConflicts: countFor(webhookConflicts, attempt.id),
      resultConflicts: countFor(resultConflicts, attempt.id),
    }));
  }

  async inspect(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        reference: true,
        createdAt: true,
        updatedAt: true,
        merchant: { select: { id: true, slug: true, status: true } },
        attempts: {
          orderBy: { attemptNumber: 'asc' },
          select: {
            id: true,
            attemptNumber: true,
            provider: true,
            status: true,
            failureCode: true,
            providerReference: true,
            createdAt: true,
            submittedAt: true,
            completedAt: true,
            outboxJobs: {
              orderBy: { createdAt: 'asc' },
              select: JOB_FIELDS,
            },
          },
        },
        events: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            createdAt: true,
            type: true,
            source: true,
            attemptId: true,
            paymentStatusBefore: true,
            paymentStatusAfter: true,
            attemptStatusBefore: true,
            attemptStatusAfter: true,
            actor: true,
            requestId: true,
            outboxJobId: true,
            webhookEventId: true,
            details: true,
          },
        },
      },
    });
    if (!payment) return null;

    const webhookEvents = await this.prisma.providerWebhookEvent.findMany({
      where: {
        attemptId: { in: payment.attempts.map((attempt) => attempt.id) },
      },
      orderBy: { receivedAt: 'asc' },
      select: {
        id: true,
        eventId: true,
        eventType: true,
        attemptId: true,
        providerReference: true,
        status: true,
        result: true,
        eventCreatedAt: true,
        receivedAt: true,
        processedAt: true,
        duplicateDeliveries: true,
        conflictingDeliveries: true,
      },
    });

    return {
      ...payment,
      attempts: payment.attempts.map((attempt) => ({
        ...attempt,
        diagnosis:
          attempt.status === PaymentAttemptStatus.PENDING
            ? diagnoseUnresolved(attempt.outboxJobs)
            : null,
      })),
      webhookEvents,
    };
  }
}

export type PaymentInvestigation = NonNullable<
  Awaited<ReturnType<PaymentInvestigator['inspect']>>
>;
export type UnresolvedAttempt = Awaited<
  ReturnType<PaymentInvestigator['unresolved']>
>[number];
