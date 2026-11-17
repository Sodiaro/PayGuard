import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestContext } from '../common/logging/request-context.js';
import type { CoreEnvironment } from '../config/environment.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  OutboxErrorCategory,
  OutboxJobType,
  PaymentActionStatus,
  PaymentActionType,
  PaymentEventSource,
  PaymentStatus,
} from '../generated/prisma/enums.js';
import {
  MerchantEventType,
  recordPaymentOutcomeEvent,
} from '../merchant-webhooks/merchant-events.js';
import type { ClaimedJob } from '../outbox/outbox-store.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { PaymentStateConflictError } from '../payments/payment-errors.js';
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
  type ProviderActionLookupResult,
  type ProviderActionResult,
} from '../payments/providers/payment-provider.js';
import {
  actionStatusesThatCanBecome,
  matchesRecordedAction,
  PAYMENT_STATUS_AFTER,
  resolveAction,
  type ActionResolution,
} from './payment-action-lifecycle.js';

interface PendingAction {
  id: string;
  type: PaymentActionType;
  amount: bigint | null;
  submittedAt: Date | null;
  merchantId: string;
  payment: { currency: string };
  attempt: { id: string; providerReference: string | null };
}

type UnknownOutcomeHandler = (category: OutboxErrorCategory) => Promise<void>;

// Executes PROCESS_PAYMENT_ACTION and RECONCILE_PAYMENT_ACTION jobs with the same discipline as
// attempts and refunds: marked submitted before the provider is called, a missing answer resolved
// by lookup, resubmitted (under the same action ID) only when the provider has no record of it,
// and every outcome committed together with the job's completion.
@Injectable()
export class PaymentActionJobProcessor {
  private readonly logger = new Logger(PaymentActionJobProcessor.name);
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

  async process(job: ClaimedJob): Promise<void> {
    if (!job.paymentActionId) {
      throw new Error(`Payment action job ${job.id} has no action`);
    }
    const action = await this.prisma.paymentAction.findFirst({
      where: { id: job.paymentActionId, status: PaymentActionStatus.PENDING },
      select: {
        id: true,
        type: true,
        amount: true,
        submittedAt: true,
        merchantId: true,
        payment: { select: { currency: true } },
        attempt: { select: { id: true, providerReference: true } },
      },
    });

    // Redelivered work for an action that already has an outcome: nothing left to do.
    if (!action) {
      await this.outbox.complete(this.prisma, job);
      return;
    }

    const context = requestContext.getStore();
    if (context) context.merchantId = action.merchantId;

    if (job.type === OutboxJobType.PROCESS_PAYMENT_ACTION) {
      await this.processAction(job, action);
    } else {
      await this.reconcileAction(job, action);
    }
  }

  private async processAction(
    job: ClaimedJob,
    action: PendingAction,
  ): Promise<void> {
    // Once submission may have happened, the provider may already have captured or voided.
    if (action.submittedAt) {
      await this.handOverToReconciliation(job, action, 0);
      return;
    }
    const marked = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentAction.updateMany({
        where: {
          id: action.id,
          status: PaymentActionStatus.PENDING,
          submittedAt: null,
        },
        data: { submittedAt: new Date() },
      });
      if (updated.count === 1) {
        await recordPaymentEvent(tx, {
          ...eventFor(job),
          type: PaymentEventType.ACTION_SUBMITTED,
          source: PaymentEventSource.WORKER,
          details: { actionType: action.type },
        });
      }
      return updated.count === 1;
    });
    if (!marked) {
      await this.handOverToReconciliation(job, action, 0);
      return;
    }

    await this.submit(job, action, (category) =>
      this.handOverToReconciliation(
        job,
        action,
        this.reconciliationDelaySeconds,
        category,
      ),
    );
  }

  private async reconcileAction(
    job: ClaimedJob,
    action: PendingAction,
  ): Promise<void> {
    let lookup: ProviderActionLookupResult;
    const startedAt = performance.now();
    try {
      lookup = await withProviderTimeout(
        this.provider.lookupPaymentAction({
          actionId: action.id,
          type: action.type === PaymentActionType.CAPTURE ? 'capture' : 'void',
        }),
      );
    } catch (error) {
      await this.retryLater(job, providerErrorCategory(error));
      return;
    }
    this.logger.log('Provider capture/void lookup answered', {
      ...jobFields(job),
      lookupStatus: knownLookupStatus(lookup),
      providerDurationMs: elapsedMs(startedAt),
    });

    switch (lookup.status) {
      case 'succeeded':
        await this.recordAndComplete(
          job,
          action,
          resolveAction({
            outcome: 'succeeded',
            providerReference: lookup.providerReference,
          }),
          PaymentEventSource.PROVIDER_LOOKUP,
        );
        return;
      case 'declined':
        await this.recordAndComplete(
          job,
          action,
          resolveAction({
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
        // The provider never received this action, so it is safe to submit under the same ID.
        await this.submit(job, action, (category) =>
          this.retryLater(job, category),
        );
        return;
      default:
        await this.retryLater(job, OutboxErrorCategory.PROVIDER_ERROR);
    }
  }

  private async submit(
    job: ClaimedJob,
    action: PendingAction,
    onUnknownOutcome: UnknownOutcomeHandler,
  ): Promise<void> {
    const providerReference = action.attempt.providerReference;
    if (!providerReference) {
      throw new Error(`Authorization ${action.attempt.id} has no reference`);
    }
    let resolution: ActionResolution;
    const startedAt = performance.now();
    try {
      const result: ProviderActionResult = await withProviderTimeout(
        action.type === PaymentActionType.CAPTURE
          ? this.provider.capturePayment({
              actionId: action.id,
              attemptId: action.attempt.id,
              providerReference,
              amount: Number(action.amount),
              currency: action.payment.currency,
            })
          : this.provider.voidPayment({
              actionId: action.id,
              attemptId: action.attempt.id,
              providerReference,
            }),
      );
      resolution = resolveAction(result);
    } catch (error) {
      const category = providerErrorCategory(error);
      this.logger.warn(
        'Capture/void submission ended without a definite outcome',
        {
          ...jobFields(job),
          category,
          providerDurationMs: elapsedMs(startedAt),
        },
      );
      await onUnknownOutcome(category);
      return;
    }
    await this.recordAndComplete(
      job,
      action,
      resolution,
      PaymentEventSource.PROVIDER_RESPONSE,
      elapsedMs(startedAt),
    );
  }

  private async recordAndComplete(
    job: ClaimedJob,
    action: PendingAction,
    resolution: ActionResolution,
    source: PaymentEventSource,
    providerDurationMs?: number,
  ): Promise<void> {
    const { applied, contradicted, completed } = await this.prisma.$transaction(
      async (tx) => {
        const applied = await applyActionResolution(
          tx,
          job,
          action.type,
          resolution,
          source,
        );
        const contradicted =
          !applied &&
          (await this.recordIfContradicted(
            tx,
            job,
            action,
            resolution,
            source,
          ));
        return {
          applied,
          contradicted,
          completed: await this.outbox.complete(tx, job),
        };
      },
    );

    const fields = {
      ...jobFields(job),
      actionType: action.type,
      actionStatus: resolution.status,
      failureCode: resolution.failureCode,
      providerDurationMs,
    };
    if (contradicted) {
      this.logger.error(
        'Provider answer contradicts the recorded capture/void outcome; nothing was changed',
        fields,
      );
    } else {
      this.logger.log(
        applied
          ? 'Capture/void outcome recorded'
          : 'Capture/void already had this outcome; answer ignored',
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
    job: ClaimedJob,
    action: PendingAction,
    resolution: ActionResolution,
    source: PaymentEventSource,
  ): Promise<boolean> {
    const recorded = await tx.paymentAction.findUniqueOrThrow({
      where: { id: job.paymentActionId! },
      select: { status: true, failureCode: true, providerReference: true },
    });
    if (matchesRecordedAction(recorded, resolution)) return false;

    await recordPaymentEvent(tx, {
      ...eventFor(job),
      type: PaymentEventType.ACTION_RESULT_CONFLICT,
      source,
      details: {
        actionType: action.type,
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
    job: ClaimedJob,
    action: PendingAction,
    delaySeconds: number,
    category?: OutboxErrorCategory,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.outbox.enqueue(tx, {
        type: OutboxJobType.RECONCILE_PAYMENT_ACTION,
        paymentId: job.paymentId,
        attemptId: job.attemptId,
        paymentActionId: job.paymentActionId!,
        delaySeconds,
        requestId: job.requestId,
      });
      // A worker fenced out of this job made no decision; whoever owns it now records its own.
      if (!(await this.outbox.complete(tx, job))) return;
      await recordPaymentEvent(tx, {
        ...eventFor(job),
        type: PaymentEventType.ACTION_OUTCOME_UNKNOWN,
        source: PaymentEventSource.WORKER,
        details: {
          actionType: action.type,
          reason: category ? 'no_definite_answer' : 'possibly_submitted',
          category: category ?? null,
          lookupDelaySeconds: delaySeconds,
        },
      });
    });
    this.logger.log('Capture/void handed to reconciliation', {
      ...jobFields(job),
      category,
      delaySeconds,
    });
  }

  private retryLater(
    job: ClaimedJob,
    category: OutboxErrorCategory,
  ): Promise<void> {
    return retryLater(this.outbox, this.logger, job, category);
  }
}

// Returns false when the action already has an outcome. A succeeded capture or void moves the
// payment out of AUTHORIZED in the same transaction; a failed one leaves it authorized.
async function applyActionResolution(
  tx: Prisma.TransactionClient,
  job: ClaimedJob,
  type: PaymentActionType,
  resolution: ActionResolution,
  source: PaymentEventSource,
): Promise<boolean> {
  const updated = await tx.paymentAction.updateMany({
    where: {
      id: job.paymentActionId!,
      status: { in: actionStatusesThatCanBecome(resolution.status) },
    },
    data: {
      status: resolution.status,
      providerReference: resolution.providerReference,
      failureCode: resolution.failureCode,
      completedAt: new Date(),
    },
  });
  if (updated.count !== 1) return false;

  const succeeded = resolution.status === PaymentActionStatus.SUCCEEDED;
  const paymentStatusAfter = PAYMENT_STATUS_AFTER[type];
  if (succeeded) {
    const payment = await tx.payment.updateMany({
      where: { id: job.paymentId, status: PaymentStatus.AUTHORIZED },
      data: { status: paymentStatusAfter },
    });
    if (payment.count !== 1) throw new PaymentStateConflictError(job.paymentId);
  }

  await recordPaymentEvent(tx, {
    ...eventFor(job),
    type: PaymentEventType.ACTION_RESOLVED,
    source,
    paymentStatusBefore: succeeded ? PaymentStatus.AUTHORIZED : null,
    paymentStatusAfter: succeeded ? paymentStatusAfter : null,
    details: {
      actionType: type,
      actionStatusBefore: PaymentActionStatus.PENDING,
      actionStatusAfter: resolution.status,
      providerReference: resolution.providerReference,
      failureCode: resolution.failureCode,
    },
  });
  await recordPaymentOutcomeEvent(
    tx,
    job.paymentId,
    job.attemptId,
    succeeded
      ? undefined
      : type === PaymentActionType.CAPTURE
        ? MerchantEventType.PAYMENT_CAPTURE_FAILED
        : MerchantEventType.PAYMENT_VOID_FAILED,
  );
  return true;
}

function eventFor(job: ClaimedJob) {
  return {
    paymentId: job.paymentId,
    attemptId: job.attemptId,
    paymentActionId: job.paymentActionId,
    outboxJobId: job.id,
  };
}
