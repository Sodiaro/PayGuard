import { Injectable } from '@nestjs/common';
import { requestContext } from '../common/logging/request-context.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  OutboxJobType,
  ProviderWebhookEventResult,
  ProviderWebhookEventStatus,
} from '../generated/prisma/enums.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import {
  fingerprintWebhookEvent,
  type ProviderWebhookEvent,
} from './provider-webhook.requests.js';

export type WebhookAcceptance = 'accepted' | 'duplicate' | 'payload_conflict';

export interface AcceptedWebhook {
  acceptance: WebhookAcceptance;
  // Set when the event is unknown to processing: it was recorded without being queued.
  unknownAttempt: boolean;
}

// Durable intake for verified provider events. Nothing here changes payment state: an event is
// stored together with the outbox job that will apply it, in one transaction, so an event that was
// acknowledged always has its processing queued, and a failed write acknowledges nothing.
@Injectable()
export class ProviderWebhookInbox {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxStore,
  ) {}

  async accept(
    provider: string,
    event: ProviderWebhookEvent,
    deliveredAt: Date,
  ): Promise<AcceptedWebhook> {
    const payloadHash = fingerprintWebhookEvent(event);

    return this.prisma.$transaction(async (tx) => {
      // Concurrent deliveries of one event serialize on the unique (provider, event_id) index:
      // the first inserts, the rest find its row once it commits.
      const [created] = await tx.providerWebhookEvent.createManyAndReturn({
        data: [
          {
            provider,
            eventId: event.id,
            eventType: event.type,
            attemptId: event.data.attemptId,
            providerReference: event.data.providerReference,
            amount: BigInt(event.data.amount),
            currency: event.data.currency,
            eventCreatedAt: new Date(event.createdAt),
            deliveredAt,
            payloadHash,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      if (created) {
        const queued = await this.schedule(
          tx,
          provider,
          created.id,
          event.data.attemptId,
        );
        return { acceptance: 'accepted', unknownAttempt: !queued };
      }

      const existing = await tx.providerWebhookEvent.findUniqueOrThrow({
        where: { provider_eventId: { provider, eventId: event.id } },
        select: { id: true, payloadHash: true },
      });
      if (existing.payloadHash === payloadHash) {
        await tx.providerWebhookEvent.update({
          where: { id: existing.id },
          data: { duplicateDeliveries: { increment: 1 } },
        });
        return { acceptance: 'duplicate', unknownAttempt: false };
      }

      // The conflicting content is not stored. The stored event is marked so that, if it is
      // still unprocessed, processing distrusts it and asks the provider instead.
      await tx.providerWebhookEvent.update({
        where: { id: existing.id },
        data: {
          conflictingDeliveries: { increment: 1 },
          lastConflictAt: new Date(),
        },
      });
      return { acceptance: 'payload_conflict', unknownAttempt: false };
    });
  }

  private async schedule(
    tx: Prisma.TransactionClient,
    provider: string,
    webhookEventId: string,
    attemptId: string,
  ): Promise<boolean> {
    const attempt = await tx.paymentAttempt.findFirst({
      where: { id: attemptId, provider },
      select: { paymentId: true },
    });
    if (!attempt) {
      await tx.providerWebhookEvent.update({
        where: { id: webhookEventId },
        data: {
          status: ProviderWebhookEventStatus.PROCESSED,
          result: ProviderWebhookEventResult.UNKNOWN_ATTEMPT,
          processedAt: new Date(),
        },
      });
      return false;
    }
    await this.outbox.enqueue(tx, {
      type: OutboxJobType.APPLY_WEBHOOK_EVENT,
      paymentId: attempt.paymentId,
      attemptId,
      webhookEventId,
      requestId: requestContext.getStore()?.requestId ?? null,
    });
    return true;
  }
}
