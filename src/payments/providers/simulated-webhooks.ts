import { createHash } from 'node:crypto';
import type {
  ProviderWebhookEvent,
  ProviderWebhookEventType,
} from '../../webhooks/provider-webhook.requests.js';
import { webhookSignatureHeader } from '../../webhooks/webhook-signature.js';
import {
  referenceFor,
  SimulatorOutcome,
} from './simulated-payment-provider.js';

export const SIMULATOR_SIGNATURE_HEADER = 'x-simulator-signature';

export interface SimulatedWebhookAttempt {
  attemptId: string;
  amount: number;
  currency: string;
}

export interface SignedWebhookDelivery {
  body: string;
  signature: string;
}

// The webhook the simulator would send for an attempt. Event IDs and provider references derive
// from the attempt ID and event type alone, so every redelivery of an event is identical, like a
// real provider retrying one stored event.
export function simulatedWebhookEvent(
  attempt: SimulatedWebhookAttempt,
  type: ProviderWebhookEventType,
  createdAt: Date,
): ProviderWebhookEvent {
  const id = createHash('sha256')
    .update(`${attempt.attemptId}:${type}`)
    .digest('hex')
    .slice(0, 24);
  return {
    id: `evt_${id}`,
    type,
    createdAt: createdAt.toISOString(),
    data: {
      attemptId: attempt.attemptId,
      providerReference: referenceFor(attempt.attemptId),
      amount: attempt.amount,
      currency: attempt.currency as ProviderWebhookEvent['data']['currency'],
    },
  };
}

// UNAVAILABLE means nothing was processed, so the provider has nothing to notify.
export function webhookTypeForOutcome(
  outcome: SimulatorOutcome,
): ProviderWebhookEventType | null {
  switch (outcome) {
    case SimulatorOutcome.Succeeded:
      return 'payment.succeeded';
    case SimulatorOutcome.Declined:
      return 'payment.declined';
    case SimulatorOutcome.Unavailable:
      return null;
  }
}

// The timestamp is explicit so deliveries are reproducible and tests control the clock.
export function signSimulatedWebhook(
  secret: string,
  event: ProviderWebhookEvent,
  timestampSeconds: number,
): SignedWebhookDelivery {
  const body = JSON.stringify(event);
  return {
    body,
    signature: webhookSignatureHeader(secret, timestampSeconds, body),
  };
}
