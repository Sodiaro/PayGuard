import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestContext } from '../common/logging/request-context.js';
import type { CoreEnvironment } from '../config/environment.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  OutboxErrorCategory,
  OutboxJobType,
  PaymentEventSource,
  RefundStatus,
} from '../generated/prisma/enums.js';
import { recordRefundOutcomeEvent } from '../merchant-webhooks/merchant-events.js';
import type { PaymentJob } from '../outbox/outbox-store.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import {
  PaymentEventType,
  recordPaymentEvent,
} from '../payments/payment-events.js';
import {
  elapsedMs,
  jobFields,
  knownLookupStatus,
  providerErrorCategory,
  retryLater,
} from '../payments/processing/job-support.js';
import {
  PAYMENT_PROVIDER,
  withProviderTimeout,
  type PaymentProvider,
  type ProviderRefundLookupResult,
} from '../payments/providers/payment-provider.js';
import {
  matchesRecordedRefund,
  refundStatusesThatCanBecome,
  resolveRefund,
  type RefundResolution,
} from './refund-lifecycle.js';

interface PendingRefund {
  id: string;
  amount: bigint;
  currency: string;
  submittedAt: Date | null;
  merchantId: string;
  attempt: { id: string; providerReference: string | null };
}

type UnknownOutcomeHandler = (category: OutboxErrorCategory) => Promise<void>;

// Executes PROCESS_REFUND and RECONCILE_REFUND jobs with the same discipline as attempts: the
// refund is marked submitted before the provider is called, a missing answer is resolved by lookup,
// it is resubmitted (under the same refund ID) only when the provider has no record of it, and
// every outcome commits together with the job's completion.
@Injectable()
export class RefundJobProcessor {
  private readonly logger = new Logger(RefundJobProcessor.name);
  private readonly reconciliationDelaySeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxStore,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    config: ConfigService<CoreEnvironment, true>,
  ) {
    this.reconciliationDelaySeconds = config.get(
      'RECONCILIATION_DELAY_SECONDS',
      { infer: true },
    );
  }

  async process(job: PaymentJob): Promise<void> {
    if (!job.refundId) throw new Error(`Refund job ${job.id} has no refund`);

    const refund = await this.prisma.refund.findFirst({
      where: { id: job.refundId, status: RefundStatus.PENDING },
      select: {
        id: true,
        amount: true,
        currency: true,
        submittedAt: true,
        merchantId: true,
        attempt: { select: { id: true, providerReference: true } },
      },
    });

    // Redelivered work for a refund that already has an outcome: nothing left to do.
    if (!refund) {
      await this.outbox.complete(this.prisma, job);
      return;
    }

    const context = requestContext.getStore();
    if (context) context.merchantId = refund.merchantId;

    if (job.type === OutboxJobType.PROCESS_REFUND) {
      await this.processRefund(job, refund);
    } else {
      await this.reconcileRefund(job, refund);
    }
  }

  private async processRefund(
    job: PaymentJob,
    refund: PendingRefund,
  ): Promise<void> {
    // Once submission may have happened, the provider might already be returning the money;
    // submitting again without asking could refund twice.
    if (refund.submittedAt) {
      await this.handOverToReconciliation(job, 0);
      return;
    }
    const marked = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.refund.updateMany({
        where: {
          id: refund.id,
          status: RefundStatus.PENDING,
          submittedAt: null,
        },
        data: { submittedAt: new Date() },
      });
      if (updated.count === 1) {
        await recordPaymentEvent(tx, {
          ...eventFor(job),
          type: PaymentEventType.REFUND_SUBMITTED,
          source: PaymentEventSource.WORKER,
        });
      }
      return updated.count === 1;
    });
    if (!marked) {
      await this.handOverToReconciliation(job, 0);
      return;
    }

    await this.submit(job, refund, (category) =>
      this.handOverToReconciliation(
        job,
        this.reconciliationDelaySeconds,
        category,
      ),
    );
  }

  private async reconcileRefund(
    job: PaymentJob,
    refund: PendingRefund,
  ): Promise<void> {
    let lookup: ProviderRefundLookupResult;
    const startedAt = performance.now();
    try {
      lookup = await withProviderTimeout(
        this.provider.lookupRefund({ refundId: refund.id }),
      );
    } catch (error) {
      await this.retryLater(job, providerErrorCategory(error));
      return;
    }
    this.logger.log('Provider refund lookup answered', {
      ...jobFields(job),
      lookupStatus: knownLookupStatus(lookup),
      providerDurationMs: elapsedMs(startedAt),
    });

    switch (lookup.status) {
      case 'succeeded':
        await this.recordAndComplete(
          job,
          resolveRefund({
            outcome: 'succeeded',
            providerReference: lookup.providerReference,
          }),
          PaymentEventSource.PROVIDER_LOOKUP,
        );
        return;
      case 'declined':
        await this.recordAndComplete(
          job,
          resolveRefund({
            outcome: 'declined',
            providerReference: lookup.providerReference,
          }),
          PaymentEventSource.PROVIDER_LOOKUP,
        );
        return;
      case 'processing':
        await this.retryLater(job, OutboxErrorCategory.OUTCOME_PROCESSING);
        return;
      case 'unavailable':
        await this.retryLater(job, OutboxErrorCategory.PROVIDER_UNAVAILABLE);
        return;
      case 'not_found':
        // The provider never received this refund, so it is safe to submit under the same ID.
        await this.submit(job, refund, (category) =>
          this.retryLater(job, category),
        );
        return;
      default:
        await this.retryLater(job, OutboxErrorCategory.PROVIDER_ERROR);
    }
  }

  private async submit(
    job: PaymentJob,
    refund: PendingRefund,
    onUnknownOutcome: UnknownOutcomeHandler,
  ): Promise<void> {
    // A succeeded attempt always has a provider reference; without one there is nothing to refund
    // against, which is an internal error, not a provider answer.
    if (!refund.attempt.providerReference) {
      throw new Error(`Refunded attempt ${refund.attempt.id} has no reference`);
    }
    let resolution: RefundResolution;
    const startedAt = performance.now();
    try {
      const result = await withProviderTimeout(
        this.provider.processRefund({
          refundId: refund.id,
          attemptId: refund.attempt.id,
          providerReference: refund.attempt.providerReference,
          amount: Number(refund.amount),
          currency: refund.currency,
        }),
      );
      resolution = resolveRefund(result);
    } catch (error) {
      const category = providerErrorCategory(error);
      this.logger.warn('Refund submission ended without a definite outcome', {
        ...jobFields(job),
        category,
        providerDurationMs: elapsedMs(startedAt),
      });
      await onUnknownOutcome(category);
      return;
    }
    await this.recordAndComplete(
      job,
      resolution,
      PaymentEventSource.PROVIDER_RESPONSE,
      elapsedMs(startedAt),
    );
  }

  private async recordAndComplete(
    job: PaymentJob,
    resolution: RefundResolution,
    source: PaymentEventSource,
    providerDurationMs?: number,
  ): Promise<void> {
    const { applied, contradicted, completed } = await this.prisma.$transaction(
      async (tx) => {
        const applied = await applyRefundResolution(
          tx,
          job,
          resolution,
          source,
        );
        const contradicted =
          !applied &&
          (await this.recordIfContradicted(tx, job, resolution, source));
        return {
          applied,
          contradicted,
          completed: await this.outbox.complete(tx, job),
        };
      },
    );

    const fields = {
      ...jobFields(job),
      refundStatus: resolution.status,
      failureCode: resolution.failureCode,
      providerDurationMs,
    };
    if (contradicted) {
      this.logger.error(
        'Provider answer contradicts the recorded refund outcome; nothing was changed',
        fields,
      );
    } else {
      this.logger.log(
        applied
          ? 'Refund outcome recorded'
          : 'Refund already had this outcome; answer ignored',
        fields,
      );
    }
    if (!completed) {
      this.logger.warn(
        'Outbox job lease was lost before completion',
        jobFields(job),
      );
    }
  }

  private async recordIfContradicted(
    tx: Prisma.TransactionClient,
    job: PaymentJob,
    resolution: RefundResolution,
    source: PaymentEventSource,
  ): Promise<boolean> {
    const recorded = await tx.refund.findUniqueOrThrow({
      where: { id: job.refundId! },
      select: { status: true, failureCode: true, providerReference: true },
    });
    if (matchesRecordedRefund(recorded, resolution)) return false;

    await recordPaymentEvent(tx, {
      ...eventFor(job),
      type: PaymentEventType.REFUND_RESULT_CONFLICT,
      source,
      details: {
        reported: {
          status: resolution.status,
          failureCode: resolution.failureCode,
          providerReference: resolution.providerReference,
        },
        recorded: {
          status: recorded.status,
          failureCode: recorded.failureCode,
          providerReference: recorded.providerReference,
        },
      },
    });
    return true;
  }

  private async handOverToReconciliation(
    job: PaymentJob,
    delaySeconds: number,
    category?: OutboxErrorCategory,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.outbox.enqueue(tx, {
        type: OutboxJobType.RECONCILE_REFUND,
        paymentId: job.paymentId,
        attemptId: job.attemptId,
        refundId: job.refundId!,
        delaySeconds,
        requestId: job.requestId,
      });
      // A worker fenced out of this job made no decision; whoever owns it now records its own.
      if (!(await this.outbox.complete(tx, job))) return;
      await recordPaymentEvent(tx, {
        ...eventFor(job),
        type: PaymentEventType.REFUND_OUTCOME_UNKNOWN,
        source: PaymentEventSource.WORKER,
        details: {
          reason: category ? 'no_definite_answer' : 'possibly_submitted',
          category: category ?? null,
          lookupDelaySeconds: delaySeconds,
        },
      });
    });
    this.logger.log('Refund handed to reconciliation', {
      ...jobFields(job),
      category,
      delaySeconds,
    });
  }

  private retryLater(
    job: PaymentJob,
    category: OutboxErrorCategory,
  ): Promise<void> {
    return retryLater(this.outbox, this.logger, job, category);
  }
}

// Returns false when the refund already has an outcome, so a late, duplicate or racing answer
// never overwrites a terminal state. The payment's own status is untouched by refunds.
async function applyRefundResolution(
  tx: Prisma.TransactionClient,
  job: PaymentJob,
  resolution: RefundResolution,
  source: PaymentEventSource,
): Promise<boolean> {
  const sources = refundStatusesThatCanBecome(resolution.status);
  const updated = await tx.refund.updateMany({
    where: { id: job.refundId!, status: { in: sources } },
    data: {
      status: resolution.status,
      providerReference: resolution.providerReference,
      failureCode: resolution.failureCode,
      completedAt: new Date(),
    },
  });
  if (updated.count !== 1) return false;

  await recordPaymentEvent(tx, {
    ...eventFor(job),
    type: PaymentEventType.REFUND_RESOLVED,
    source,
    details: {
      refundStatusBefore: RefundStatus.PENDING,
      refundStatusAfter: resolution.status,
      providerReference: resolution.providerReference,
      failureCode: resolution.failureCode,
    },
  });
  await recordRefundOutcomeEvent(tx, job.refundId!);
  return true;
}

function eventFor(job: PaymentJob) {
  return {
    paymentId: job.paymentId,
    attemptId: job.attemptId,
    refundId: job.refundId,
    outboxJobId: job.id,
  };
}
