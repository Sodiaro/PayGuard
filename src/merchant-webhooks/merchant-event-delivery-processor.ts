import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestContext } from '../common/logging/request-context.js';
import type { CoreEnvironment } from '../config/environment.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  MerchantEventDeliveryStatus,
  MerchantWebhookDeliveryError,
  OutboxErrorCategory,
} from '../generated/prisma/enums.js';
import type { ClaimedJob } from '../outbox/outbox-store.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { jobFields } from '../payments/processing/job-support.js';
import { computeWebhookSignature } from '../webhooks/webhook-signature.js';
import { merchantEventEnvelope } from './merchant-events.js';
import {
  WebhookDeliveryClient,
  type DeliveryResult,
} from './webhook-delivery-client.js';
import { WebhookSecretCipher } from './webhook-secrets.js';

export const SIGNATURE_HEADER = 'PayGuard-Signature';

// Slower than provider backoff: a merchant endpoint that is down usually stays down for minutes,
// and a delivery has no money riding on it. 30 s doubling, capped at an hour.
export function deliveryBackoffSeconds(runCount: number): number {
  return Math.min(30 * 2 ** Math.max(0, runCount - 1), 3600);
}

class LeaseLostError extends Error {}

// Executes DELIVER_MERCHANT_EVENT jobs. The HTTP call happens outside any transaction; its result,
// the event's delivery state and the job's next step commit together. Deliveries are at least
// once: a crash after the merchant accepted one but before it is recorded sends it again, so
// merchants deduplicate by event ID. An endpoint that keeps failing ends the event as FAILED and
// completes the job: a merchant's outage is not a PayGuard incident, so it never becomes a DEAD job.
@Injectable()
export class MerchantEventDeliveryProcessor {
  private readonly logger = new Logger(MerchantEventDeliveryProcessor.name);
  private readonly cipher: WebhookSecretCipher | null;
  private readonly client: WebhookDeliveryClient;
  private readonly maxRuns: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxStore,
    config: ConfigService<CoreEnvironment, true>,
  ) {
    const key = config.get('MERCHANT_WEBHOOK_ENCRYPTION_KEY', { infer: true });
    this.cipher = key ? new WebhookSecretCipher(key) : null;
    this.client = new WebhookDeliveryClient(
      config.get('MERCHANT_WEBHOOK_ALLOW_PRIVATE_TARGETS', { infer: true }),
    );
    this.maxRuns = config.get('OUTBOX_MAX_RUNS', { infer: true });
  }

  async process(job: ClaimedJob): Promise<void> {
    if (!job.merchantEventId) {
      throw new Error(`Delivery job ${job.id} has no merchant event`);
    }
    const event = await this.prisma.merchantEvent.findUniqueOrThrow({
      where: { id: job.merchantEventId },
    });
    const context = requestContext.getStore();
    if (context) context.merchantId = event.merchantId;

    if (event.deliveryStatus !== MerchantEventDeliveryStatus.PENDING) {
      await this.outbox.complete(this.prisma, job);
      return;
    }

    const endpoint = await this.prisma.merchantWebhookEndpoint.findUnique({
      where: { merchantId: event.merchantId },
    });
    if (!endpoint?.enabled) {
      await this.giveUp(job, MerchantWebhookDeliveryError.ENDPOINT_DISABLED);
      return;
    }
    // Endpoints cannot be configured without the key, so a worker missing it is misconfigured:
    // retried as an internal error rather than failing the merchant's delivery.
    if (!this.cipher) {
      throw new Error(
        'MERCHANT_WEBHOOK_ENCRYPTION_KEY is not set for the worker',
      );
    }

    const secrets = [
      this.cipher.decrypt(endpoint.secretCiphertext, event.merchantId),
    ];
    if (
      endpoint.previousSecretCiphertext &&
      endpoint.previousSecretExpiresAt &&
      endpoint.previousSecretExpiresAt > new Date()
    ) {
      // One sealed under an earlier encryption key is skipped: rotating is how a merchant recovers
      // after that key changed.
      try {
        secrets.push(
          this.cipher.decrypt(
            endpoint.previousSecretCiphertext,
            event.merchantId,
          ),
        );
      } catch {
        this.logger.warn('Previous webhook secret could not be decrypted', {
          merchantEventId: event.id,
        });
      }
    }

    const body = JSON.stringify(merchantEventEnvelope(event));
    const timestamp = Math.floor(Date.now() / 1000);
    const startedAt = performance.now();
    const result = await this.client.post(endpoint.url, body, {
      [SIGNATURE_HEADER]: signatureHeader(secrets, timestamp, body),
      'PayGuard-Event-Id': event.id,
      'PayGuard-Event-Type': event.type,
    });
    const durationMs = Math.round(performance.now() - startedAt);

    try {
      await this.record(job, result);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
      this.logger.warn(
        'Delivery job lease was lost; its result was not recorded',
        jobFields(job),
      );
      return;
    }

    const fields = {
      ...jobFields(job),
      merchantEventId: event.id,
      eventType: event.type,
      responseStatus: result.status,
      durationMs,
    };
    if (result.delivered) {
      this.logger.log('Merchant event delivered', fields);
    } else {
      this.logger.warn('Merchant event delivery failed', {
        ...fields,
        error: result.error,
        runCount: job.runCount,
      });
    }
  }

  private async record(job: ClaimedJob, result: DeliveryResult): Promise<void> {
    const now = new Date();
    const finalAttempt = !result.delivered && job.runCount >= this.maxRuns;
    await this.prisma.$transaction(async (tx) => {
      if (result.delivered || finalAttempt) {
        // A fenced-out worker that did deliver still records it: the delivery happened.
        const completed = await this.outbox.complete(tx, job);
        if (!completed && !result.delivered) throw new LeaseLostError();
      } else {
        const outcome = await this.outbox.reschedule(
          tx,
          job,
          OutboxErrorCategory.DELIVERY_FAILED,
          deliveryBackoffSeconds(job.runCount),
        );
        if (outcome === 'lease_lost') throw new LeaseLostError();
      }
      await tx.merchantEvent.update({
        where: { id: job.merchantEventId! },
        data: {
          deliveryStatus: result.delivered
            ? MerchantEventDeliveryStatus.DELIVERED
            : finalAttempt
              ? MerchantEventDeliveryStatus.FAILED
              : MerchantEventDeliveryStatus.PENDING,
          deliveryAttempts: { increment: 1 },
          lastAttemptAt: now,
          lastResponseStatus: result.status,
          lastError: result.delivered ? null : result.error,
          deliveredAt: result.delivered ? now : null,
        },
      });
    });
  }

  private async giveUp(
    job: ClaimedJob,
    error: MerchantWebhookDeliveryError,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await this.outbox.complete(tx, job))) return;
      await tx.merchantEvent.update({
        where: { id: job.merchantEventId! },
        data: {
          deliveryStatus: MerchantEventDeliveryStatus.FAILED,
          lastError: error,
        },
      });
    });
    this.logger.warn('Merchant event not delivered: endpoint disabled', {
      ...jobFields(job),
      merchantEventId: job.merchantEventId,
    });
  }
}

// One v1 signature per active secret, so a merchant verifying with either the new or the
// previous secret during a rotation accepts the delivery.
export function signatureHeader(
  secrets: readonly string[],
  timestamp: number,
  body: string,
): string {
  return [
    `t=${timestamp}`,
    ...secrets.map(
      (secret) => `v1=${computeWebhookSignature(secret, timestamp, body)}`,
    ),
  ].join(',');
}
