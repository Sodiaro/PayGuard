import { describe, expect, it } from '@jest/globals';
import {
  PaymentAttemptStatus,
  PaymentFailureCode,
  PaymentStatus,
  ProviderWebhookEventResult,
} from '../generated/prisma/enums.js';
import {
  decideWebhookEvent,
  type StoredWebhookEvent,
  type WebhookTargetAttempt,
} from './webhook-event-policy.js';

const event = (
  overrides: Partial<StoredWebhookEvent> = {},
): StoredWebhookEvent => ({
  eventType: 'payment.succeeded',
  providerReference: 'sim_reference',
  amount: 500000n,
  currency: 'NGN',
  conflictingDeliveries: 0,
  ...overrides,
});

const attempt = (
  overrides: Partial<WebhookTargetAttempt> = {},
): WebhookTargetAttempt => ({
  status: PaymentAttemptStatus.PENDING,
  failureCode: null,
  providerReference: null,
  submittedAt: new Date(),
  payment: { amount: 500000n, currency: 'NGN' },
  ...overrides,
});

const succeeded = attempt({
  status: PaymentAttemptStatus.SUCCEEDED,
  providerReference: 'sim_reference',
});
const declined = attempt({
  status: PaymentAttemptStatus.FAILED,
  failureCode: PaymentFailureCode.DECLINED,
  providerReference: 'sim_reference',
});
const unavailable = attempt({
  status: PaymentAttemptStatus.FAILED,
  failureCode: PaymentFailureCode.PROVIDER_UNAVAILABLE,
});

const record = (result: ProviderWebhookEventResult, reconcile = false) => ({
  action: 'record',
  result,
  reconcile,
});

describe('decideWebhookEvent', () => {
  it('applies a terminal event to a pending attempt through the lifecycle resolution', () => {
    expect(decideWebhookEvent(event(), attempt())).toEqual({
      action: 'apply',
      resolution: {
        attemptStatus: PaymentAttemptStatus.SUCCEEDED,
        paymentStatus: PaymentStatus.SUCCEEDED,
        providerReference: 'sim_reference',
        failureCode: null,
      },
    });
    expect(
      decideWebhookEvent(event({ eventType: 'payment.declined' }), attempt()),
    ).toMatchObject({
      action: 'apply',
      resolution: {
        attemptStatus: PaymentAttemptStatus.FAILED,
        failureCode: PaymentFailureCode.DECLINED,
      },
    });
  });

  it('records an event that repeats the recorded outcome as already applied', () => {
    expect(decideWebhookEvent(event(), succeeded)).toEqual(
      record(ProviderWebhookEventResult.ALREADY_APPLIED),
    );
    expect(
      decideWebhookEvent(event({ eventType: 'payment.declined' }), declined),
    ).toEqual(record(ProviderWebhookEventResult.ALREADY_APPLIED));
  });

  it.each([
    ['a decline after a success', 'payment.declined', succeeded],
    ['a success after a decline', 'payment.succeeded', declined],
    [
      'a success after the provider refused the attempt',
      'payment.succeeded',
      unavailable,
    ],
  ])('never overwrites a final outcome: %s', (_case, eventType, current) => {
    expect(decideWebhookEvent(event({ eventType }), current)).toEqual(
      record(ProviderWebhookEventResult.OUTCOME_CONFLICT),
    );
  });

  it('treats a different provider reference for the same outcome as a conflict', () => {
    expect(
      decideWebhookEvent(event({ providerReference: 'sim_other' }), succeeded),
    ).toEqual(record(ProviderWebhookEventResult.OUTCOME_CONFLICT));
  });

  it('ignores a late or early processing notice whatever the state', () => {
    for (const current of [attempt(), succeeded, declined]) {
      expect(
        decideWebhookEvent(event({ eventType: 'payment.processing' }), current),
      ).toEqual(record(ProviderWebhookEventResult.NO_ACTION));
    }
  });

  it('records an event for an unknown attempt without acting on it', () => {
    expect(decideWebhookEvent(event(), null)).toEqual(
      record(ProviderWebhookEventResult.UNKNOWN_ATTEMPT),
    );
  });

  it.each([
    ['amount', { amount: 500001n }],
    ['currency', { currency: 'GHS' }],
  ])(
    'does not apply an event whose %s differs, and asks the provider instead',
    (_field, overrides) => {
      expect(decideWebhookEvent(event(overrides), attempt())).toEqual(
        record(ProviderWebhookEventResult.DATA_MISMATCH, true),
      );
      expect(decideWebhookEvent(event(overrides), succeeded)).toEqual(
        record(ProviderWebhookEventResult.DATA_MISMATCH, false),
      );
    },
  );

  it('distrusts an event whose ID was reused with different content', () => {
    expect(
      decideWebhookEvent(event({ conflictingDeliveries: 1 }), attempt()),
    ).toEqual(record(ProviderWebhookEventResult.PAYLOAD_CONFLICT, true));
  });

  it('leaves a never-submitted attempt to its own processing job rather than a lookup', () => {
    expect(
      decideWebhookEvent(event({ amount: 1n }), attempt({ submittedAt: null })),
    ).toEqual(record(ProviderWebhookEventResult.DATA_MISMATCH, false));
  });
});
