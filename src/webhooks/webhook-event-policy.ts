import {
  PaymentAttemptStatus,
  ProviderWebhookEventResult,
  type PaymentFailureCode,
} from '../generated/prisma/enums.js';
import {
  resolveAttempt,
  type AttemptResolution,
} from '../payments/payment-lifecycle.js';

export interface StoredWebhookEvent {
  eventType: string;
  providerReference: string;
  amount: bigint;
  currency: string;
  conflictingDeliveries: number;
}

export interface WebhookTargetAttempt {
  status: PaymentAttemptStatus;
  failureCode: PaymentFailureCode | null;
  providerReference: string | null;
  submittedAt: Date | null;
  payment: { amount: bigint; currency: string };
}

export type WebhookDecision =
  | { action: 'apply'; resolution: AttemptResolution }
  | {
      action: 'record';
      result: ProviderWebhookEventResult;
      // Ask the provider directly instead of trusting this event.
      reconcile: boolean;
    };

// A webhook is a claim by the provider, not permission to set state. It can only move a PENDING
// attempt along a transition the lifecycle allows, and only when it agrees with what PayGuard
// asked the provider to charge. Anything it cannot safely apply is recorded and, while the attempt
// is unresolved and was submitted, handed to reconciliation so a provider lookup decides.
export function decideWebhookEvent(
  event: StoredWebhookEvent,
  attempt: WebhookTargetAttempt | null,
): WebhookDecision {
  if (!attempt) {
    return record(ProviderWebhookEventResult.UNKNOWN_ATTEMPT, false);
  }
  const pendingAndSubmitted =
    attempt.status === PaymentAttemptStatus.PENDING &&
    attempt.submittedAt !== null;

  if (event.conflictingDeliveries > 0) {
    return record(
      ProviderWebhookEventResult.PAYLOAD_CONFLICT,
      pendingAndSubmitted,
    );
  }
  if (
    event.amount !== attempt.payment.amount ||
    event.currency !== attempt.payment.currency
  ) {
    return record(
      ProviderWebhookEventResult.DATA_MISMATCH,
      pendingAndSubmitted,
    );
  }

  const resolution = resolutionFor(event);
  if (!resolution) return record(ProviderWebhookEventResult.NO_ACTION, false);

  if (attempt.status === PaymentAttemptStatus.PENDING) {
    return { action: 'apply', resolution };
  }
  return record(
    sameOutcome(attempt, resolution)
      ? ProviderWebhookEventResult.ALREADY_APPLIED
      : ProviderWebhookEventResult.OUTCOME_CONFLICT,
    false,
  );
}

// Only terminal event types carry an outcome; payment.processing is informational, so a late one
// can never move an attempt backwards.
function resolutionFor(event: StoredWebhookEvent): AttemptResolution | null {
  switch (event.eventType) {
    case 'payment.succeeded':
      return resolveAttempt({
        outcome: 'succeeded',
        providerReference: event.providerReference,
      });
    case 'payment.declined':
      return resolveAttempt({
        outcome: 'declined',
        providerReference: event.providerReference,
      });
    default:
      return null;
  }
}

function sameOutcome(
  attempt: WebhookTargetAttempt,
  resolution: AttemptResolution,
): boolean {
  return (
    attempt.status === resolution.attemptStatus &&
    attempt.failureCode === resolution.failureCode &&
    (attempt.providerReference === null ||
      attempt.providerReference === resolution.providerReference)
  );
}

function record(
  result: ProviderWebhookEventResult,
  reconcile: boolean,
): WebhookDecision {
  return { action: 'record', result, reconcile };
}
