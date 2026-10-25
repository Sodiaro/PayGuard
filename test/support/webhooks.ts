import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { PaymentResponse } from '../../src/payments/payment.responses.js';
import {
  SIMULATOR_SIGNATURE_HEADER,
  simulatedWebhookEvent,
} from '../../src/payments/providers/simulated-webhooks.js';
import type {
  ProviderWebhookEvent,
  ProviderWebhookEventType,
} from '../../src/webhooks/provider-webhook.requests.js';
import { webhookSignatureHeader } from '../../src/webhooks/webhook-signature.js';

export const WEBHOOK_PATH = '/v1/webhooks/simulator';

export function testWebhookSecret(): string {
  const secret = process.env.SIMULATOR_WEBHOOK_SECRET;
  if (!secret) throw new Error('SIMULATOR_WEBHOOK_SECRET is not set');
  return secret;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// The event the simulator would send for the payment's latest attempt.
export function eventFor(
  payment: PaymentResponse,
  type: ProviderWebhookEventType,
  createdAt = new Date(),
): ProviderWebhookEvent {
  return simulatedWebhookEvent(
    {
      attemptId: payment.attempts.at(-1)!.id,
      amount: payment.amount,
      currency: payment.currency,
    },
    type,
    createdAt,
  );
}

export interface DeliveryOptions {
  // Signed over these bytes instead of the delivered body.
  signedBody?: string | Buffer;
  timestamp?: number;
  secret?: string;
  // A literal header value, or null to send none.
  signature?: string | null;
  contentType?: string;
  headers?: Record<string, string>;
}

// Delivers like the provider would: the body is sent byte for byte as signed.
export function webhooksApi(app: INestApplication<App>) {
  return {
    deliver(
      event: ProviderWebhookEvent | string | Buffer,
      options: DeliveryOptions = {},
    ) {
      const body =
        typeof event === 'string' || Buffer.isBuffer(event)
          ? event
          : JSON.stringify(event);
      const timestamp = options.timestamp ?? nowSeconds();
      const signature =
        options.signature === undefined
          ? webhookSignatureHeader(
              options.secret ?? testWebhookSecret(),
              timestamp,
              options.signedBody ?? body,
            )
          : options.signature;

      const req = request(app.getHttpServer())
        .post(WEBHOOK_PATH)
        .set('Content-Type', options.contentType ?? 'application/json');
      if (signature !== null) req.set(SIMULATOR_SIGNATURE_HEADER, signature);
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        req.set(name, value);
      }
      // Superagent would JSON-encode a Buffer sent as application/json; send its bytes instead.
      if (Buffer.isBuffer(body)) {
        req.serialize((value: Buffer) => value as unknown as string);
      }
      return req.send(body);
    },
  };
}
