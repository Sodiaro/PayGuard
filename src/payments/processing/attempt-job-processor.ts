import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestContext } from '../../common/logging/request-context.js';
import type { CoreEnvironment } from '../../config/environment.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  OutboxErrorCategory,
  OutboxJobType,
  PaymentAttemptStatus,
} from '../../generated/prisma/enums.js';
import type { ClaimedJob } from '../../outbox/outbox-store.js';
import { OutboxStore } from '../../outbox/outbox-store.js';
import { ProviderWebhookProcessor } from '../../webhooks/provider-webhook-processor.js';
import { applyAttemptResolution } from '../attempt-outcomes.js';
import {
  resolveAttempt,
  type AttemptResolution,
} from '../payment-lifecycle.js';
import {
  PAYMENT_PROVIDER,
  ProviderTimeoutError,
  withProviderTimeout,
  type PaymentProvider,
  type ProviderLookupResult,
} from '../providers/payment-provider.js';

interface PendingAttempt {
  id: string;
  paymentId: string;
  submittedAt: Date | null;
  payment: { merchantId: string; amount: bigint; currency: string };
}

type UnknownOutcomeHandler = (category: OutboxErrorCategory) => Promise<void>;

// Executes one claimed outbox job. Provider calls happen outside any transaction; every outcome is
// written together with the job's completion, so a job is never marked done before its result is
// stored. Errors are recorded as sanitized categories, never as raw provider messages.
@Injectable()
export class AttemptJobProcessor {
  private readonly logger = new Logger(AttemptJobProcessor.name);
  private readonly reconciliationDelaySeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxStore,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly webhooks: ProviderWebhookProcessor,
    config: ConfigService<CoreEnvironment, true>,
  ) {
    this.reconciliationDelaySeconds = config.get(
      'RECONCILIATION_DELAY_SECONDS',
      { infer: true },
    );
  }

  // Never throws: internal failures are rescheduled, and if even that fails the job's lease
  // expires and another claim recovers it.
  async handle(job: ClaimedJob): Promise<void> {
    await requestContext.run(
      { requestId: job.requestId ?? `job:${job.id}` },
      async () => {
        if (job.reclaimed) {
          this.logger.warn('Reclaimed outbox job after its lease expired', {
            ...jobFields(job),
            runCount: job.runCount,
          });
        }
        try {
          if (this.outbox.hasExhaustedRuns(job)) {
            await this.retryLater(job, OutboxErrorCategory.LEASE_EXPIRED);
            return;
          }
          await this.dispatch(job);
        } catch (error) {
          this.logger.error(
            'Outbox job failed internally',
            error instanceof Error ? error.stack : String(error),
            jobFields(job),
          );
          await this.retryLater(job, OutboxErrorCategory.INTERNAL_ERROR).catch(
            () =>
              this.logger.error(
                'Could not reschedule outbox job; it will be reclaimed when its lease expires',
                jobFields(job),
              ),
          );
        }
      },
    );
  }

  private async dispatch(job: ClaimedJob): Promise<void> {
    // Webhook events must be classified even when the attempt already has an outcome.
    if (job.type === OutboxJobType.APPLY_WEBHOOK_EVENT) {
      await this.webhooks.process(job);
      return;
    }

    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { id: job.attemptId, status: PaymentAttemptStatus.PENDING },
      select: {
        id: true,
        paymentId: true,
        submittedAt: true,
        payment: {
          select: { merchantId: true, amount: true, currency: true },
        },
      },
    });

    // Redelivered work for an attempt that already has an outcome: nothing left to do.
    if (!attempt) {
      await this.outbox.complete(this.prisma, job);
      return;
    }

    const context = requestContext.getStore();
    if (context) context.merchantId = attempt.payment.merchantId;

    if (job.type === OutboxJobType.PROCESS_ATTEMPT) {
      await this.processAttempt(job, attempt);
    } else {
      await this.reconcileAttempt(job, attempt);
    }
  }

  private async processAttempt(
    job: ClaimedJob,
    attempt: PendingAttempt,
  ): Promise<void> {
    // Once submission may have happened, the provider might hold an outcome; submitting again
    // without asking could double-charge, so the attempt is handed to reconciliation instead.
    if (attempt.submittedAt) {
      await this.handOverToReconciliation(job, 0);
      return;
    }
    const marked = await this.prisma.paymentAttempt.updateMany({
      where: {
        id: attempt.id,
        status: PaymentAttemptStatus.PENDING,
        submittedAt: null,
      },
      data: { submittedAt: new Date() },
    });
    if (marked.count === 0) {
      await this.handOverToReconciliation(job, 0);
      return;
    }

    await this.submit(job, attempt, (category) =>
      this.handOverToReconciliation(
        job,
        this.reconciliationDelaySeconds,
        category,
      ),
    );
  }

  private async reconcileAttempt(
    job: ClaimedJob,
    attempt: PendingAttempt,
  ): Promise<void> {
    let lookup: ProviderLookupResult;
    const startedAt = performance.now();
    try {
      lookup = await withProviderTimeout(
        this.provider.lookupPayment({ attemptId: attempt.id }),
      );
    } catch (error) {
      await this.retryLater(job, providerErrorCategory(error));
      return;
    }
    this.logger.log('Provider lookup answered', {
      ...jobFields(job),
      lookupStatus: knownLookupStatus(lookup),
      providerDurationMs: elapsedMs(startedAt),
    });

    switch (lookup.status) {
      case 'succeeded':
        await this.recordAndComplete(
          job,
          resolveAttempt({
            outcome: 'succeeded',
            providerReference: lookup.providerReference,
          }),
        );
        return;
      case 'declined':
        await this.recordAndComplete(
          job,
          resolveAttempt({
            outcome: 'declined',
            providerReference: lookup.providerReference,
          }),
        );
        return;
      case 'processing':
        await this.retryLater(job, OutboxErrorCategory.OUTCOME_PROCESSING);
        return;
      case 'unavailable':
        await this.retryLater(job, OutboxErrorCategory.PROVIDER_UNAVAILABLE);
        return;
      case 'not_found':
        // The provider never received this attempt, so it is safe to submit under the same ID.
        await this.submit(job, attempt, (category) =>
          this.retryLater(job, category),
        );
        return;
      default:
        await this.retryLater(job, OutboxErrorCategory.PROVIDER_ERROR);
    }
  }

  private async submit(
    job: ClaimedJob,
    attempt: PendingAttempt,
    onUnknownOutcome: UnknownOutcomeHandler,
  ): Promise<void> {
    let resolution: AttemptResolution;
    const startedAt = performance.now();
    try {
      const result = await withProviderTimeout(
        this.provider.processPayment({
          attemptId: attempt.id,
          merchantId: attempt.payment.merchantId,
          amount: Number(attempt.payment.amount),
          currency: attempt.payment.currency,
        }),
      );
      resolution = resolveAttempt(result);
    } catch (error) {
      const category = providerErrorCategory(error);
      this.logger.warn('Payment submission ended without a definite outcome', {
        ...jobFields(job),
        category,
        providerDurationMs: elapsedMs(startedAt),
      });
      await onUnknownOutcome(category);
      return;
    }
    await this.recordAndComplete(job, resolution, elapsedMs(startedAt));
  }

  private async recordAndComplete(
    job: ClaimedJob,
    resolution: AttemptResolution,
    providerDurationMs?: number,
  ): Promise<void> {
    const { applied, completed } = await this.prisma.$transaction(
      async (tx) => ({
        applied: await applyAttemptResolution(tx, job.attemptId, resolution),
        completed: await this.outbox.complete(tx, job),
      }),
    );

    this.logger.log(
      applied
        ? 'Attempt outcome recorded'
        : 'Attempt already had an outcome; result ignored',
      {
        ...jobFields(job),
        attemptStatus: resolution.attemptStatus,
        failureCode: resolution.failureCode,
        providerDurationMs,
      },
    );
    if (!completed) {
      this.logger.warn(
        'Outbox job lease was lost before completion',
        jobFields(job),
      );
    }
  }

  private async handOverToReconciliation(
    job: ClaimedJob,
    delaySeconds: number,
    category?: OutboxErrorCategory,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.outbox.enqueue(tx, {
        type: OutboxJobType.RECONCILE_ATTEMPT,
        paymentId: job.paymentId,
        attemptId: job.attemptId,
        delaySeconds,
        requestId: job.requestId,
      });
      await this.outbox.complete(tx, job);
    });
    this.logger.log('Attempt handed to reconciliation', {
      ...jobFields(job),
      category,
      delaySeconds,
    });
  }

  private async retryLater(
    job: ClaimedJob,
    category: OutboxErrorCategory,
  ): Promise<void> {
    const outcome = await this.outbox.reschedule(this.prisma, job, category);
    const fields = { ...jobFields(job), category, runCount: job.runCount };
    if (outcome === 'dead') {
      this.logger.error(
        'Outbox job exhausted its runs; needs investigation',
        fields,
      );
    } else if (outcome === 'rescheduled') {
      this.logger.warn('Outbox job rescheduled', fields);
    }
  }
}

function providerErrorCategory(error: unknown): OutboxErrorCategory {
  return error instanceof ProviderTimeoutError
    ? OutboxErrorCategory.PROVIDER_TIMEOUT
    : OutboxErrorCategory.PROVIDER_ERROR;
}

function jobFields(job: ClaimedJob) {
  return {
    jobId: job.id,
    jobType: job.type,
    paymentId: job.paymentId,
    attemptId: job.attemptId,
  };
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

// Logged instead of the raw value so an unexpected provider answer cannot inject arbitrary text.
function knownLookupStatus(lookup: ProviderLookupResult): string {
  const known = [
    'succeeded',
    'declined',
    'processing',
    'not_found',
    'unavailable',
  ];
  return known.includes(lookup.status) ? lookup.status : 'unrecognised';
}
