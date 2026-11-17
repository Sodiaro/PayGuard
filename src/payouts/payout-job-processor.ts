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
  PayoutStatus,
} from '../generated/prisma/enums.js';
import { recordPayoutOutcomeEvent } from '../merchant-webhooks/merchant-events.js';
import type { PayoutJob } from '../outbox/outbox-store.js';
import { OutboxStore } from '../outbox/outbox-store.js';
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
  type ProviderPayoutLookupResult,
} from '../payments/providers/payment-provider.js';
import { PayoutEventType, recordPayoutEvent } from './payout-events.js';
import {
  matchesRecordedPayout,
  payoutStatusesThatCanBecome,
  resolvePayout,
  type PayoutResolution,
} from './payout-lifecycle.js';

interface PendingPayout {
  id: string;
  merchantId: string;
  amount: bigint;
  currency: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  submittedAt: Date | null;
}

type UnknownOutcomeHandler = (category: OutboxErrorCategory) => Promise<void>;

// Executes PROCESS_PAYOUT and RECONCILE_PAYOUT jobs with the same discipline as attempts and
// refunds: marked submitted before the provider is called, a missing answer resolved by lookup,
// resubmitted (under the same payout ID) only when the provider has no record of it, and every
// outcome committed together with the job's completion.
@Injectable()
export class PayoutJobProcessor {
  private readonly logger = new Logger(PayoutJobProcessor.name);
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

  async process(job: PayoutJob): Promise<void> {
    const payout = await this.prisma.payout.findFirst({
      where: { id: job.payoutId, status: PayoutStatus.PENDING },
      select: {
        id: true,
        merchantId: true,
        amount: true,
        currency: true,
        bankCode: true,
        accountNumber: true,
        accountName: true,
        submittedAt: true,
      },
    });

    // Redelivered work for a payout that already has an outcome: nothing left to do.
    if (!payout) {
      await this.outbox.complete(this.prisma, job);
      return;
    }

    const context = requestContext.getStore();
    if (context) context.merchantId = payout.merchantId;

    if (job.type === OutboxJobType.PROCESS_PAYOUT) {
      await this.processPayout(job, payout);
    } else {
      await this.reconcilePayout(job, payout);
    }
  }

  private async processPayout(
    job: PayoutJob,
    payout: PendingPayout,
  ): Promise<void> {
    // Once submission may have happened, the money may already be on its way; submitting again
    // without asking could pay out twice.
    if (payout.submittedAt) {
      await this.handOverToReconciliation(job, 0);
      return;
    }
    const marked = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payout.updateMany({
        where: {
          id: payout.id,
          status: PayoutStatus.PENDING,
          submittedAt: null,
        },
        data: { submittedAt: new Date() },
      });
      if (updated.count === 1) {
        await recordPayoutEvent(tx, {
          payoutId: payout.id,
          type: PayoutEventType.PAYOUT_SUBMITTED,
          source: PaymentEventSource.WORKER,
          outboxJobId: job.id,
        });
      }
      return updated.count === 1;
    });
    if (!marked) {
      await this.handOverToReconciliation(job, 0);
      return;
    }

    await this.submit(job, payout, (category) =>
      this.handOverToReconciliation(
        job,
        this.reconciliationDelaySeconds,
        category,
      ),
    );
  }

  private async reconcilePayout(
    job: PayoutJob,
    payout: PendingPayout,
  ): Promise<void> {
    let lookup: ProviderPayoutLookupResult;
    const startedAt = performance.now();
    try {
      lookup = await withProviderTimeout(
        this.provider.lookupPayout({ payoutId: payout.id }),
      );
    } catch (error) {
      await this.retryLater(job, providerErrorCategory(error));
      return;
    }
    this.logger.log('Provider payout lookup answered', {
      ...jobFields(job),
      lookupStatus: knownLookupStatus(lookup),
      providerDurationMs: elapsedMs(startedAt),
    });

    switch (lookup.status) {
      case 'succeeded':
      case 'declined':
        await this.recordAndComplete(
          job,
          resolvePayout(
            lookup.status === 'succeeded'
              ? {
                  outcome: 'succeeded',
                  providerReference: lookup.providerReference,
                }
              : {
                  outcome: 'declined',
                  providerReference: lookup.providerReference,
                },
          ),
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
        // The provider never received this payout, so it is safe to submit under the same ID.
        await this.submit(job, payout, (category) =>
          this.retryLater(job, category),
        );
        return;
      default:
        await this.retryLater(job, OutboxErrorCategory.PROVIDER_ERROR);
    }
  }

  private async submit(
    job: PayoutJob,
    payout: PendingPayout,
    onUnknownOutcome: UnknownOutcomeHandler,
  ): Promise<void> {
    let resolution: PayoutResolution;
    const startedAt = performance.now();
    try {
      const result = await withProviderTimeout(
        this.provider.processPayout({
          payoutId: payout.id,
          merchantId: payout.merchantId,
          amount: Number(payout.amount),
          currency: payout.currency,
          destination: {
            bankCode: payout.bankCode,
            accountNumber: payout.accountNumber,
            accountName: payout.accountName,
          },
        }),
      );
      resolution = resolvePayout(result);
    } catch (error) {
      const category = providerErrorCategory(error);
      this.logger.warn('Payout submission ended without a definite outcome', {
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
    job: PayoutJob,
    resolution: PayoutResolution,
    source: PaymentEventSource,
    providerDurationMs?: number,
  ): Promise<void> {
    const { applied, contradicted, completed } = await this.prisma.$transaction(
      async (tx) => {
        const applied = await applyPayoutResolution(
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
      payoutStatus: resolution.status,
      failureCode: resolution.failureCode,
      providerDurationMs,
    };
    if (contradicted) {
      this.logger.error(
        'Provider answer contradicts the recorded payout outcome; nothing was changed',
        fields,
      );
    } else {
      this.logger.log(
        applied
          ? 'Payout outcome recorded'
          : 'Payout already had this outcome; answer ignored',
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
    job: PayoutJob,
    resolution: PayoutResolution,
    source: PaymentEventSource,
  ): Promise<boolean> {
    const recorded = await tx.payout.findUniqueOrThrow({
      where: { id: job.payoutId },
      select: { status: true, failureCode: true, providerReference: true },
    });
    if (matchesRecordedPayout(recorded, resolution)) return false;

    await recordPayoutEvent(tx, {
      payoutId: job.payoutId,
      type: PayoutEventType.PAYOUT_RESULT_CONFLICT,
      source,
      outboxJobId: job.id,
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
    job: PayoutJob,
    delaySeconds: number,
    category?: OutboxErrorCategory,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.outbox.enqueue(tx, {
        type: OutboxJobType.RECONCILE_PAYOUT,
        payoutId: job.payoutId,
        delaySeconds,
        requestId: job.requestId,
      });
      // A worker fenced out of this job made no decision; whoever owns it now records its own.
      if (!(await this.outbox.complete(tx, job))) return;
      await recordPayoutEvent(tx, {
        payoutId: job.payoutId,
        type: PayoutEventType.PAYOUT_OUTCOME_UNKNOWN,
        source: PaymentEventSource.WORKER,
        outboxJobId: job.id,
        details: {
          reason: category ? 'no_definite_answer' : 'possibly_submitted',
          category: category ?? null,
          lookupDelaySeconds: delaySeconds,
        },
      });
    });
    this.logger.log('Payout handed to reconciliation', {
      ...jobFields(job),
      category,
      delaySeconds,
    });
  }

  private retryLater(
    job: PayoutJob,
    category: OutboxErrorCategory,
  ): Promise<void> {
    return retryLater(this.outbox, this.logger, job, category);
  }
}

// Returns false when the payout already has an outcome, so a late, duplicate or racing answer never
// overwrites a terminal state.
async function applyPayoutResolution(
  tx: Prisma.TransactionClient,
  job: PayoutJob,
  resolution: PayoutResolution,
  source: PaymentEventSource,
): Promise<boolean> {
  const updated = await tx.payout.updateMany({
    where: {
      id: job.payoutId,
      status: { in: payoutStatusesThatCanBecome(resolution.status) },
    },
    data: {
      status: resolution.status,
      providerReference: resolution.providerReference,
      failureCode: resolution.failureCode,
      completedAt: new Date(),
    },
  });
  if (updated.count !== 1) return false;

  await recordPayoutEvent(tx, {
    payoutId: job.payoutId,
    type: PayoutEventType.PAYOUT_RESOLVED,
    source,
    statusBefore: PayoutStatus.PENDING,
    statusAfter: resolution.status,
    outboxJobId: job.id,
    details: {
      providerReference: resolution.providerReference,
      failureCode: resolution.failureCode,
    },
  });
  await recordPayoutOutcomeEvent(tx, job.payoutId);
  return true;
}
