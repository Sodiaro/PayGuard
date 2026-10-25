import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  OutboxJobType,
  ProviderWebhookEventResult,
  ProviderWebhookEventStatus,
} from '../generated/prisma/enums.js';
import type { ClaimedJob } from '../outbox/outbox-store.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { applyAttemptResolution } from '../payments/attempt-outcomes.js';
import {
  decideWebhookEvent,
  type StoredWebhookEvent,
  type WebhookTargetAttempt,
} from './webhook-event-policy.js';

const TARGET_ATTEMPT_FIELDS = {
  status: true,
  failureCode: true,
  providerReference: true,
  submittedAt: true,
  payment: { select: { amount: true, currency: true } },
} satisfies Prisma.PaymentAttemptSelect;

class LeaseLostError extends Error {}

// Applies one stored provider event (an APPLY_WEBHOOK_EVENT outbox job). The event row is locked
// and its result, any payment change and the job's completion commit together, so a redelivered
// job, a second worker or a crash part-way through can never apply an event twice.
@Injectable()
export class ProviderWebhookProcessor {
  private readonly logger = new Logger(ProviderWebhookProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxStore,
  ) {}

  async process(job: ClaimedJob): Promise<void> {
    if (!job.webhookEventId) {
      throw new Error(`Webhook job ${job.id} has no webhook event`);
    }
    const webhookEventId = job.webhookEventId;

    let outcome: { result: ProviderWebhookEventResult; repeated: boolean };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM provider_webhook_events WHERE id = ${webhookEventId}::uuid FOR UPDATE`;
        const event = await tx.providerWebhookEvent.findUniqueOrThrow({
          where: { id: webhookEventId },
        });

        if (event.status === ProviderWebhookEventStatus.PROCESSED) {
          await this.completeOrRollBack(tx, job);
          return { result: event.result!, repeated: true };
        }

        const result = await this.decideAndApply(tx, job, event);
        await tx.providerWebhookEvent.update({
          where: { id: webhookEventId },
          data: {
            status: ProviderWebhookEventStatus.PROCESSED,
            result,
            processedAt: new Date(),
          },
        });
        await this.completeOrRollBack(tx, job);
        return { result, repeated: false };
      });
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
      this.logger.warn(
        'Webhook job lease was lost; its changes were rolled back',
        fields(job),
      );
      return;
    }

    this.log(job, outcome.result, outcome.repeated);
  }

  private async decideAndApply(
    tx: Prisma.TransactionClient,
    job: ClaimedJob,
    event: StoredWebhookEvent & { attemptId: string },
  ): Promise<ProviderWebhookEventResult> {
    const attempt = await this.findAttempt(tx, event.attemptId);
    const decision = decideWebhookEvent(event, attempt);

    if (decision.action === 'record') {
      if (decision.reconcile) {
        await this.outbox.enqueue(tx, {
          type: OutboxJobType.RECONCILE_ATTEMPT,
          paymentId: job.paymentId,
          attemptId: job.attemptId,
          requestId: job.requestId,
        });
      }
      return decision.result;
    }

    if (
      await applyAttemptResolution(tx, event.attemptId, decision.resolution)
    ) {
      return ProviderWebhookEventResult.APPLIED;
    }
    // Another writer (reconciliation, the submission's own answer) resolved the attempt between
    // the read and the guarded update; classify against what it recorded.
    const settled = decideWebhookEvent(
      event,
      await this.findAttempt(tx, event.attemptId),
    );
    if (settled.action === 'apply') {
      throw new Error(`Attempt ${event.attemptId} is pending but not writable`);
    }
    return settled.result;
  }

  private findAttempt(
    tx: Prisma.TransactionClient,
    attemptId: string,
  ): Promise<WebhookTargetAttempt | null> {
    return tx.paymentAttempt.findUnique({
      where: { id: attemptId },
      select: TARGET_ATTEMPT_FIELDS,
    });
  }

  private async completeOrRollBack(
    tx: Prisma.TransactionClient,
    job: ClaimedJob,
  ): Promise<void> {
    if (!(await this.outbox.complete(tx, job))) throw new LeaseLostError();
  }

  private log(
    job: ClaimedJob,
    result: ProviderWebhookEventResult,
    repeated: boolean,
  ): void {
    const logFields = { ...fields(job), result };
    if (repeated) {
      this.logger.log('Webhook event was already processed', logFields);
    } else if (NEEDS_ATTENTION.has(result)) {
      this.logger.error(
        'Webhook event contradicts recorded state; nothing was changed',
        logFields,
      );
    } else {
      this.logger.log('Webhook event processed', logFields);
    }
  }
}

const NEEDS_ATTENTION: ReadonlySet<ProviderWebhookEventResult> = new Set([
  ProviderWebhookEventResult.OUTCOME_CONFLICT,
  ProviderWebhookEventResult.DATA_MISMATCH,
  ProviderWebhookEventResult.PAYLOAD_CONFLICT,
]);

function fields(job: ClaimedJob) {
  return {
    jobId: job.id,
    webhookEventId: job.webhookEventId,
    paymentId: job.paymentId,
    attemptId: job.attemptId,
  };
}
