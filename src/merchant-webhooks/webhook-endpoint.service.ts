import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestValidationException } from '../common/http/validation.js';
import type { CoreEnvironment } from '../config/environment.js';
import { isUniqueViolation } from '../database/prisma-errors.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PutWebhookEndpointRequest } from './merchant-webhook.requests.js';
import type { WebhookEndpointResponse } from './merchant-webhook.responses.js';
import {
  generateWebhookSecret,
  PREVIOUS_SECRET_OVERLAP_HOURS,
  WebhookSecretCipher,
} from './webhook-secrets.js';
import { webhookUrlProblem } from './webhook-targets.js';

type EndpointRecord = Prisma.MerchantWebhookEndpointGetPayload<object>;

export class MerchantWebhooksNotConfiguredError extends Error {
  constructor() {
    super('Merchant webhooks are not configured');
  }
}

export class WebhookEndpointNotFoundError extends Error {
  constructor() {
    super('Webhook endpoint not configured');
  }
}

// A merchant's own notification endpoint. The signing secret is generated here, returned once,
// and stored only encrypted.
@Injectable()
export class WebhookEndpointService {
  private readonly cipher: WebhookSecretCipher | null;
  private readonly allowPrivateTargets: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<CoreEnvironment, true>,
  ) {
    const key = config.get('MERCHANT_WEBHOOK_ENCRYPTION_KEY', { infer: true });
    this.cipher = key ? new WebhookSecretCipher(key) : null;
    this.allowPrivateTargets = config.get(
      'MERCHANT_WEBHOOK_ALLOW_PRIVATE_TARGETS',
      { infer: true },
    );
  }

  async find(merchantId: string): Promise<WebhookEndpointResponse | null> {
    const endpoint = await this.prisma.merchantWebhookEndpoint.findUnique({
      where: { merchantId },
    });
    return endpoint && toResponse(endpoint);
  }

  // Creates the endpoint with a new secret, or updates its URL and state. A repeated create (for
  // example after a lost response) is an update and returns no secret; rotate to get a new one.
  async put(
    merchantId: string,
    request: PutWebhookEndpointRequest,
  ): Promise<{ endpoint: WebhookEndpointResponse; created: boolean }> {
    const problem = webhookUrlProblem(request.url, this.allowPrivateTargets);
    if (problem) {
      throw new RequestValidationException([
        { field: 'url', messages: [problem] },
      ]);
    }
    const cipher = this.requireCipher();

    const updated = await this.update(merchantId, request);
    if (updated) return { endpoint: toResponse(updated), created: false };

    const secret = generateWebhookSecret();
    try {
      const created = await this.prisma.merchantWebhookEndpoint.create({
        data: {
          merchantId,
          url: request.url,
          enabled: request.enabled ?? true,
          secretCiphertext: cipher.encrypt(secret, merchantId),
        },
      });
      return { endpoint: { ...toResponse(created), secret }, created: true };
    } catch (error) {
      // A concurrent request created it first; apply this one as an update.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.update(merchantId, request);
      if (!raced) throw error;
      return { endpoint: toResponse(raced), created: false };
    }
  }

  // The replaced secret keeps signing deliveries for PREVIOUS_SECRET_OVERLAP_HOURS. Rotating again
  // within that window replaces it: only the two newest secrets are ever valid.
  async rotateSecret(merchantId: string): Promise<WebhookEndpointResponse> {
    const cipher = this.requireCipher();
    const secret = generateWebhookSecret();
    const rotated = await this.prisma.$transaction(async (tx) => {
      // Serializes rotations, so two at once cannot both keep the same secret as "previous".
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM merchant_webhook_endpoints
        WHERE merchant_id = ${merchantId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new WebhookEndpointNotFoundError();
      const current = await tx.merchantWebhookEndpoint.findUniqueOrThrow({
        where: { merchantId },
        select: { secretCiphertext: true },
      });
      const now = new Date();
      return tx.merchantWebhookEndpoint.update({
        where: { merchantId },
        data: {
          secretCiphertext: cipher.encrypt(secret, merchantId),
          previousSecretCiphertext: current.secretCiphertext,
          previousSecretExpiresAt: new Date(
            now.getTime() + PREVIOUS_SECRET_OVERLAP_HOURS * 3_600_000,
          ),
          secretRotatedAt: now,
        },
      });
    });
    return { ...toResponse(rotated), secret };
  }

  private async update(
    merchantId: string,
    request: PutWebhookEndpointRequest,
  ): Promise<EndpointRecord | null> {
    const [updated] =
      await this.prisma.merchantWebhookEndpoint.updateManyAndReturn({
        where: { merchantId },
        data: {
          url: request.url,
          ...(request.enabled !== undefined && { enabled: request.enabled }),
        },
      });
    return updated ?? null;
  }

  private requireCipher(): WebhookSecretCipher {
    if (!this.cipher) throw new MerchantWebhooksNotConfiguredError();
    return this.cipher;
  }
}

function toResponse(endpoint: EndpointRecord): WebhookEndpointResponse {
  return {
    url: endpoint.url,
    enabled: endpoint.enabled,
    secretRotatedAt: endpoint.secretRotatedAt,
    previousSecretExpiresAt: endpoint.previousSecretExpiresAt,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}
