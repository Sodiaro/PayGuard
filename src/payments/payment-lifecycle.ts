import {
  PaymentAttemptStatus,
  PaymentFailureCode,
  PaymentStatus,
} from '../generated/prisma/enums.js';
import type { ProviderPaymentResult } from './providers/payment-provider.js';

// Every status write is a conditional update whose WHERE clause is derived from these tables, so
// an unlisted transition cannot happen even under concurrency. FAILED -> PENDING is reserved for
// retries, which start a new attempt.
export const PAYMENT_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  [PaymentStatus.PENDING]: [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED],
  [PaymentStatus.FAILED]: [PaymentStatus.PENDING],
  [PaymentStatus.SUCCEEDED]: [],
};

export const ATTEMPT_TRANSITIONS: Readonly<
  Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]>
> = {
  [PaymentAttemptStatus.PENDING]: [
    PaymentAttemptStatus.SUCCEEDED,
    PaymentAttemptStatus.FAILED,
  ],
  [PaymentAttemptStatus.SUCCEEDED]: [],
  [PaymentAttemptStatus.FAILED]: [],
};

export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function canTransitionAttempt(
  from: PaymentAttemptStatus,
  to: PaymentAttemptStatus,
): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function paymentStatusesThatCanBecome(
  to: PaymentStatus,
): PaymentStatus[] {
  return Object.values(PaymentStatus).filter((from) =>
    canTransitionPayment(from, to),
  );
}

export function attemptStatusesThatCanBecome(
  to: PaymentAttemptStatus,
): PaymentAttemptStatus[] {
  return Object.values(PaymentAttemptStatus).filter((from) =>
    canTransitionAttempt(from, to),
  );
}

export interface AttemptResolution {
  attemptStatus: PaymentAttemptStatus;
  paymentStatus: PaymentStatus;
  providerReference: string | null;
  failureCode: PaymentFailureCode | null;
}

// "Unavailable" means the provider refused the request without processing it; it must never be
// recorded as a decline.
export function resolveAttempt(
  result: ProviderPaymentResult,
): AttemptResolution {
  switch (result.outcome) {
    case 'succeeded':
      return {
        attemptStatus: PaymentAttemptStatus.SUCCEEDED,
        paymentStatus: PaymentStatus.SUCCEEDED,
        providerReference: result.providerReference,
        failureCode: null,
      };
    case 'declined':
      return {
        attemptStatus: PaymentAttemptStatus.FAILED,
        paymentStatus: PaymentStatus.FAILED,
        providerReference: result.providerReference,
        failureCode: PaymentFailureCode.DECLINED,
      };
    case 'unavailable':
      return {
        attemptStatus: PaymentAttemptStatus.FAILED,
        paymentStatus: PaymentStatus.FAILED,
        providerReference: null,
        failureCode: PaymentFailureCode.PROVIDER_UNAVAILABLE,
      };
    default: {
      const unexpected: never = result;
      throw new Error(
        `Unrecognised provider outcome: ${JSON.stringify((unexpected as { outcome?: unknown }).outcome)}`,
      );
    }
  }
}

export const MAX_ATTEMPTS_PER_PAYMENT = 3;

// Declines are retryable because soft declines (e.g. insufficient funds) are often resolved by the
// customer; MAX_ATTEMPTS_PER_PAYMENT bounds retrying either way.
export const RETRYABLE_FAILURE_CODES: ReadonlySet<PaymentFailureCode> = new Set(
  [PaymentFailureCode.DECLINED, PaymentFailureCode.PROVIDER_UNAVAILABLE],
);

export type RetryEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | 'payment_not_failed'
        | 'attempt_in_progress'
        | 'failure_not_retryable'
        | 'attempt_limit_reached';
    };

export function retryEligibility(
  payment: { status: PaymentStatus },
  attempts: readonly {
    status: PaymentAttemptStatus;
    failureCode: PaymentFailureCode | null;
  }[],
): RetryEligibility {
  if (payment.status !== PaymentStatus.FAILED) {
    return { eligible: false, reason: 'payment_not_failed' };
  }
  if (
    attempts.some((attempt) => attempt.status === PaymentAttemptStatus.PENDING)
  ) {
    return { eligible: false, reason: 'attempt_in_progress' };
  }
  const latest = attempts.at(-1);
  if (
    !latest?.failureCode ||
    !RETRYABLE_FAILURE_CODES.has(latest.failureCode)
  ) {
    return { eligible: false, reason: 'failure_not_retryable' };
  }
  if (attempts.length >= MAX_ATTEMPTS_PER_PAYMENT) {
    return { eligible: false, reason: 'attempt_limit_reached' };
  }
  return { eligible: true };
}
