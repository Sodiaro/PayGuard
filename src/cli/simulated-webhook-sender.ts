import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NodeEnvironment,
  type CoreEnvironment,
} from '../config/environment.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  SIMULATOR_SIGNATURE_HEADER,
  signSimulatedWebhook,
  simulatedWebhookEvent,
  webhookTypeForOutcome,
} from '../payments/providers/simulated-webhooks.js';
import {
  PROVIDER_WEBHOOK_EVENT_TYPES,
  type ProviderWebhookEventType,
} from '../webhooks/provider-webhook.requests.js';

const UUID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DELIVERY_TIMEOUT_MS = 10_000;

export class SimulatorWebhookError extends Error {}

export interface SimulatedWebhookDeliveryResult {
  eventId: string;
  type: ProviderWebhookEventType;
  statusCode: number;
  receipt: string;
}

// Plays the simulated provider: signs the webhook it would send for an attempt and delivers it
// over HTTP, exactly as an external sender would. A development and demonstration tool only.
@Injectable()
export class SimulatedWebhookSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<CoreEnvironment, true>,
  ) {}

  async send(input: {
    attemptId: string;
    type?: string;
    baseUrl: string;
  }): Promise<SimulatedWebhookDeliveryResult> {
    if (
      this.config.get('NODE_ENV', { infer: true }) ===
      NodeEnvironment.Production
    ) {
      throw new SimulatorWebhookError(
        'Simulator commands are disabled when NODE_ENV=production',
      );
    }
    const secret = this.config.get('SIMULATOR_WEBHOOK_SECRET', {
      infer: true,
    });
    if (!secret) {
      throw new SimulatorWebhookError('SIMULATOR_WEBHOOK_SECRET is not set');
    }
    const type = this.eventType(input.type);
    const url = webhookUrl(input.baseUrl);
    if (!UUID_FORMAT.test(input.attemptId)) {
      throw new SimulatorWebhookError('--attempt must be an attempt ID');
    }

    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { id: input.attemptId, provider: 'simulator' },
      select: {
        id: true,
        createdAt: true,
        submittedAt: true,
        payment: { select: { amount: true, currency: true } },
      },
    });
    if (!attempt) {
      throw new SimulatorWebhookError(
        `No simulator attempt with id ${input.attemptId}`,
      );
    }

    // The event's creation time comes from the attempt, so sending again redelivers the same
    // event (a duplicate), as a provider retry would. Only the signed delivery time is current.
    const event = simulatedWebhookEvent(
      {
        attemptId: attempt.id,
        amount: Number(attempt.payment.amount),
        currency: attempt.payment.currency,
      },
      type,
      attempt.submittedAt ?? attempt.createdAt,
    );
    const delivery = signSimulatedWebhook(
      secret,
      event,
      Math.floor(Date.now() / 1000),
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIMULATOR_SIGNATURE_HEADER]: delivery.signature,
        },
        body: delivery.body,
        redirect: 'error',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
    } catch {
      throw new SimulatorWebhookError(`Could not deliver to ${url}`);
    }
    const body = (await response.json().catch(() => ({}))) as {
      status?: unknown;
      message?: unknown;
    };
    return {
      eventId: event.id,
      type,
      statusCode: response.status,
      receipt:
        [body.status, body.message].find(
          (value): value is string => typeof value === 'string',
        ) ?? '',
    };
  }

  private eventType(requested: string | undefined): ProviderWebhookEventType {
    if (requested !== undefined) {
      if (
        !(PROVIDER_WEBHOOK_EVENT_TYPES as readonly string[]).includes(requested)
      ) {
        throw new SimulatorWebhookError(
          `--type must be one of: ${PROVIDER_WEBHOOK_EVENT_TYPES.join(', ')}`,
        );
      }
      return requested as ProviderWebhookEventType;
    }
    const type = webhookTypeForOutcome(
      this.config.get('PAYMENT_SIMULATOR_OUTCOME', { infer: true }),
    );
    if (!type) {
      throw new SimulatorWebhookError(
        'The configured UNAVAILABLE outcome sends no webhook; pass --type',
      );
    }
    return type;
  }
}

function webhookUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL('/v1/webhooks/simulator', baseUrl);
  } catch {
    throw new SimulatorWebhookError('--url must be an http(s) base URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SimulatorWebhookError('--url must be an http(s) base URL');
  }
  return url.toString();
}
