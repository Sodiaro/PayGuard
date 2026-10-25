import { describe, expect, it } from '@jest/globals';
import { verifyWebhookSignature } from '../../webhooks/webhook-signature.js';
import { SimulatorOutcome } from './simulated-payment-provider.js';
import {
  signSimulatedWebhook,
  simulatedWebhookEvent,
  webhookTypeForOutcome,
} from './simulated-webhooks.js';

const ATTEMPT = {
  attemptId: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b',
  amount: 500000,
  currency: 'NGN',
};
const CREATED_AT = new Date('2026-10-25T12:00:00.000Z');

describe('simulated webhooks', () => {
  it('builds the same event for the same attempt and type every time', () => {
    const first = simulatedWebhookEvent(
      ATTEMPT,
      'payment.succeeded',
      CREATED_AT,
    );
    const again = simulatedWebhookEvent(
      ATTEMPT,
      'payment.succeeded',
      CREATED_AT,
    );

    expect(again).toEqual(first);
    expect(first).toEqual({
      id: expect.stringMatching(/^evt_[0-9a-f]{24}$/) as unknown as string,
      type: 'payment.succeeded',
      createdAt: '2026-10-25T12:00:00.000Z',
      data: {
        ...ATTEMPT,
        providerReference: expect.stringMatching(
          /^sim_[0-9a-f]{24}$/,
        ) as unknown as string,
      },
    });
  });

  it('gives each event type of an attempt its own ID but the same provider reference', () => {
    const succeeded = simulatedWebhookEvent(
      ATTEMPT,
      'payment.succeeded',
      CREATED_AT,
    );
    const processing = simulatedWebhookEvent(
      ATTEMPT,
      'payment.processing',
      CREATED_AT,
    );

    expect(processing.id).not.toBe(succeeded.id);
    expect(processing.data.providerReference).toBe(
      succeeded.data.providerReference,
    );
  });

  it('maps configured outcomes to event types; an unavailable provider sends nothing', () => {
    expect(webhookTypeForOutcome(SimulatorOutcome.Succeeded)).toBe(
      'payment.succeeded',
    );
    expect(webhookTypeForOutcome(SimulatorOutcome.Declined)).toBe(
      'payment.declined',
    );
    expect(webhookTypeForOutcome(SimulatorOutcome.Unavailable)).toBeNull();
  });

  it('signs deliveries reproducibly so the receiver can verify them', () => {
    const secret = 'unit-test-webhook-secret-0123456789abcdef';
    const event = simulatedWebhookEvent(
      ATTEMPT,
      'payment.declined',
      CREATED_AT,
    );
    const delivery = signSimulatedWebhook(secret, event, 1_790_000_000);

    expect(signSimulatedWebhook(secret, event, 1_790_000_000)).toEqual(
      delivery,
    );
    expect(JSON.parse(delivery.body)).toEqual(event);
    expect(
      verifyWebhookSignature({
        secret,
        header: delivery.signature,
        rawBody: Buffer.from(delivery.body),
        nowSeconds: 1_790_000_000,
        toleranceSeconds: 300,
      }),
    ).toEqual({ valid: true, timestamp: 1_790_000_000 });
  });
});
