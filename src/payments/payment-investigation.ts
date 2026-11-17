import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import {
  OutboxJobStatus,
  OutboxJobType,
  PaymentActionStatus,
  PaymentAttemptStatus,
  PayoutStatus,
  ProviderWebhookEventResult,
  RefundStatus,
  type OutboxErrorCategory,
} from '../generated/prisma/enums.js';
import { PayoutEventType } from '../payouts/payout-events.js';
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

const JOB_TYPES = {
  attempt: {
    submission: OutboxJobType.PROCESS_ATTEMPT,
    lookup: OutboxJobType.RECONCILE_ATTEMPT,
  },
  refund: {
    submission: OutboxJobType.PROCESS_REFUND,
    lookup: OutboxJobType.RECONCILE_REFUND,
  },
  action: {
    submission: OutboxJobType.PROCESS_PAYMENT_ACTION,
    lookup: OutboxJobType.RECONCILE_PAYMENT_ACTION,
  },
  payout: {
    submission: OutboxJobType.PROCESS_PAYOUT,
    lookup: OutboxJobType.RECONCILE_PAYOUT,
  },
} as const;

// Attempts, refunds, actions and payouts share the same submission/lookup job pattern. Jobs of
// other kinds (a charge's refund jobs, webhook and delivery jobs) are ignored.
export function diagnoseUnresolved(
  jobs: readonly JobView[],
  kind: keyof typeof JOB_TYPES = 'attempt',
): UnresolvedDiagnosis {
  const types = JOB_TYPES[kind];
  const ownJobs = jobs.filter(
    (job) => job.type === types.submission || job.type === types.lookup,
  );
  const running = ownJobs.find(
    (job) => job.status === OutboxJobStatus.PROCESSING,
  );
  if (running) return diagnosis('in_progress', running, false);

  const lookup = ownJobs.find((job) => job.type === types.lookup);
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

  const submission = ownJobs.find((job) => job.type === types.submission);
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
        captureMethod: true,
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
              where: {
                refundId: null,
                merchantEventId: null,
                paymentActionId: null,
              },
              orderBy: { createdAt: 'asc' },
              select: JOB_FIELDS,
            },
          },
        },
        refunds: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            attemptId: true,
            amount: true,
            status: true,
            failureCode: true,
            providerReference: true,
            reference: true,
            createdAt: true,
            submittedAt: true,
            completedAt: true,
            outboxJobs: {
              orderBy: { createdAt: 'asc' },
              select: JOB_FIELDS,
            },
          },
        },
        actions: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            attemptId: true,
            type: true,
            amount: true,
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
        merchantEvents: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            type: true,
            refundId: true,
            createdAt: true,
            deliveryStatus: true,
            deliveryAttempts: true,
            lastAttemptAt: true,
            lastResponseStatus: true,
            lastError: true,
            deliveredAt: true,
            outboxJob: { select: JOB_FIELDS },
          },
        },
        events: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            createdAt: true,
            type: true,
            source: true,
            attemptId: true,
            refundId: true,
            paymentActionId: true,
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
      refunds: payment.refunds.map((refund) => ({
        ...refund,
        diagnosis:
          refund.status === RefundStatus.PENDING
            ? diagnoseUnresolved(refund.outboxJobs, 'refund')
            : null,
      })),
      actions: payment.actions.map((action) => ({
        ...action,
        diagnosis:
          action.status === PaymentActionStatus.PENDING
            ? diagnoseUnresolved(action.outboxJobs, 'action')
            : null,
      })),
      webhookEvents,
    };
  }

  async unresolvedActions(options: { limit: number; merchantId?: string }) {
    const actions = await this.prisma.paymentAction.findMany({
      where: {
        status: PaymentActionStatus.PENDING,
        ...(options.merchantId && { merchantId: options.merchantId }),
      },
      orderBy: { createdAt: 'asc' },
      take: options.limit,
      select: {
        id: true,
        type: true,
        paymentId: true,
        createdAt: true,
        submittedAt: true,
        merchant: { select: { slug: true } },
        outboxJobs: { select: JOB_FIELDS },
      },
    });
    return actions.map((action) => ({
      paymentId: action.paymentId,
      merchantSlug: action.merchant.slug,
      actionId: action.id,
      type: action.type,
      createdAt: action.createdAt,
      submitted: action.submittedAt !== null,
      diagnosis: diagnoseUnresolved(action.outboxJobs, 'action'),
    }));
  }

  async unresolvedRefunds(options: { limit: number; merchantId?: string }) {
    const refunds = await this.prisma.refund.findMany({
      where: {
        status: RefundStatus.PENDING,
        ...(options.merchantId && { merchantId: options.merchantId }),
      },
      orderBy: { createdAt: 'asc' },
      take: options.limit,
      select: {
        id: true,
        paymentId: true,
        createdAt: true,
        submittedAt: true,
        merchant: { select: { slug: true } },
        outboxJobs: { select: JOB_FIELDS },
      },
    });
    const resultConflicts = await this.prisma.paymentEvent.groupBy({
      by: ['refundId'],
      where: {
        refundId: { in: refunds.map((refund) => refund.id) },
        type: PaymentEventType.REFUND_RESULT_CONFLICT,
      },
      _count: { _all: true },
    });

    return refunds.map((refund) => ({
      paymentId: refund.paymentId,
      merchantSlug: refund.merchant.slug,
      refundId: refund.id,
      createdAt: refund.createdAt,
      submitted: refund.submittedAt !== null,
      diagnosis: diagnoseUnresolved(refund.outboxJobs, 'refund'),
      resultConflicts:
        resultConflicts.find((row) => row.refundId === refund.id)?._count
          ._all ?? 0,
    }));
  }
}

// Payouts have no payment, so they are investigated on their own.
@Injectable()
export class PayoutInvestigator {
  constructor(private readonly prisma: PrismaService) {}

  async unresolved(options: { limit: number; merchantId?: string }) {
    const payouts = await this.prisma.payout.findMany({
      where: {
        status: PayoutStatus.PENDING,
        ...(options.merchantId && { merchantId: options.merchantId }),
      },
      orderBy: { createdAt: 'asc' },
      take: options.limit,
      select: {
        id: true,
        currency: true,
        createdAt: true,
        submittedAt: true,
        merchant: { select: { slug: true } },
        outboxJobs: { select: JOB_FIELDS },
      },
    });
    const resultConflicts = await this.prisma.payoutEvent.groupBy({
      by: ['payoutId'],
      where: {
        payoutId: { in: payouts.map((payout) => payout.id) },
        type: PayoutEventType.PAYOUT_RESULT_CONFLICT,
      },
      _count: { _all: true },
    });
    return payouts.map((payout) => ({
      payoutId: payout.id,
      currency: payout.currency,
      merchantSlug: payout.merchant.slug,
      createdAt: payout.createdAt,
      submitted: payout.submittedAt !== null,
      diagnosis: diagnoseUnresolved(payout.outboxJobs, 'payout'),
      resultConflicts:
        resultConflicts.find((row) => row.payoutId === payout.id)?._count
          ._all ?? 0,
    }));
  }

  // The account number is not selected: operators see the destination as merchants do.
  async inspect(payoutId: string) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        bankCode: true,
        accountName: true,
        reference: true,
        providerReference: true,
        failureCode: true,
        createdAt: true,
        submittedAt: true,
        completedAt: true,
        merchant: { select: { id: true, slug: true, status: true } },
        outboxJobs: {
          where: { merchantEventId: null },
          orderBy: { createdAt: 'asc' },
          select: JOB_FIELDS,
        },
        merchantEvents: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            type: true,
            createdAt: true,
            deliveryStatus: true,
            deliveryAttempts: true,
            lastResponseStatus: true,
            lastError: true,
            outboxJob: { select: JOB_FIELDS },
          },
        },
        events: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            createdAt: true,
            type: true,
            source: true,
            statusBefore: true,
            statusAfter: true,
            actor: true,
            requestId: true,
            outboxJobId: true,
            details: true,
          },
        },
      },
    });
    if (!payout) return null;
    return {
      ...payout,
      diagnosis:
        payout.status === PayoutStatus.PENDING
          ? diagnoseUnresolved(payout.outboxJobs, 'payout')
          : null,
    };
  }
}

export type PayoutInvestigation = NonNullable<
  Awaited<ReturnType<PayoutInvestigator['inspect']>>
>;
export type UnresolvedPayout = Awaited<
  ReturnType<PayoutInvestigator['unresolved']>
>[number];

export type PaymentInvestigation = NonNullable<
  Awaited<ReturnType<PaymentInvestigator['inspect']>>
>;
export type UnresolvedAttempt = Awaited<
  ReturnType<PaymentInvestigator['unresolved']>
>[number];
export type UnresolvedRefund = Awaited<
  ReturnType<PaymentInvestigator['unresolvedRefunds']>
>[number];
export type UnresolvedAction = Awaited<
  ReturnType<PaymentInvestigator['unresolvedActions']>
>[number];
