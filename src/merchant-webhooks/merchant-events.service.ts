import { Injectable } from '@nestjs/common';
import { currentRequestId } from '../common/logging/request-context.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  MerchantEventDeliveryStatus,
  OutboxJobType,
} from '../generated/prisma/enums.js';
import { enqueueOutboxJob } from '../outbox/outbox-store.js';
import {
  decodePaymentCursor,
  encodePaymentCursor,
} from '../payments/payment-cursor.js';
import { DEFAULT_PAGE_SIZE } from '../payments/payment.requests.js';
import { merchantEventEnvelope } from './merchant-events.js';
import type { ListMerchantEventsQuery } from './merchant-webhook.requests.js';
import type {
  MerchantEventListResponse,
  MerchantEventResponse,
} from './merchant-webhook.responses.js';

type EventRecord = Prisma.MerchantEventGetPayload<object>;

export class MerchantEventNotFoundError extends Error {
  constructor() {
    super('Event not found');
  }
}

export class WebhookEndpointUnavailableError extends Error {
  constructor() {
    super('Webhook endpoint is not configured or is disabled');
  }
}

@Injectable()
export class MerchantEventsService {
  constructor(private readonly prisma: PrismaService) {}

  // Keyset pagination on (createdAt, id), newest first, like payments.
  async list(
    merchantId: string,
    query: ListMerchantEventsQuery,
  ): Promise<MerchantEventListResponse> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.cursor ? decodePaymentCursor(query.cursor) : null;
    const where: Prisma.MerchantEventWhereInput = {
      merchantId,
      type: query.type,
      paymentId: query.paymentId,
    };
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const rows = await this.prisma.merchantEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toResponse),
      nextCursor:
        rows.length > limit && last
          ? encodePaymentCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async find(
    merchantId: string,
    eventId: string,
  ): Promise<MerchantEventResponse | null> {
    const event = await this.prisma.merchantEvent.findFirst({
      where: { id: eventId, merchantId },
    });
    return event && toResponse(event);
  }

  // Sends the event again, with a fresh run budget, to the endpoint as it is configured now. A
  // delivery already queued or in flight is left as it is.
  async redeliver(
    merchantId: string,
    eventId: string,
  ): Promise<MerchantEventResponse> {
    const event = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM merchant_events
        WHERE id = ${eventId}::uuid AND merchant_id = ${merchantId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new MerchantEventNotFoundError();

      const endpoint = await tx.merchantWebhookEndpoint.findUnique({
        where: { merchantId },
        select: { enabled: true },
      });
      if (!endpoint?.enabled) throw new WebhookEndpointUnavailableError();

      const event = await tx.merchantEvent.findUniqueOrThrow({
        where: { id: eventId },
        include: { outboxJob: { select: { id: true } } },
      });
      if (event.outboxJob) {
        await tx.$executeRaw`
          UPDATE outbox_jobs
          SET status = 'QUEUED', run_count = 0, available_at = now(), completed_at = NULL,
              last_error = NULL, updated_at = now()
          WHERE id = ${event.outboxJob.id}::uuid AND status IN ('COMPLETED', 'DEAD')`;
      } else {
        await enqueueOutboxJob(tx, {
          type: OutboxJobType.DELIVER_MERCHANT_EVENT,
          paymentId: event.paymentId,
          attemptId: event.attemptId,
          merchantEventId: event.id,
          requestId: currentRequestId(),
        });
      }
      return tx.merchantEvent.update({
        where: { id: eventId },
        data: {
          deliveryStatus: MerchantEventDeliveryStatus.PENDING,
          deliveredAt: null,
        },
      });
    });
    return toResponse(event);
  }
}

function toResponse(event: EventRecord): MerchantEventResponse {
  return {
    ...merchantEventEnvelope(event),
    delivery: {
      status: event.deliveryStatus,
      attempts: event.deliveryAttempts,
      lastAttemptAt: event.lastAttemptAt,
      lastResponseStatus: event.lastResponseStatus,
      lastError: event.lastError,
      deliveredAt: event.deliveredAt,
    },
  };
}
