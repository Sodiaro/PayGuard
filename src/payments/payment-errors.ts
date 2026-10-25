import type { RetryEligibility } from './payment-lifecycle.js';

export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super(
      'Idempotency-Key has already been used with a different request; use a new key for a new operation',
    );
  }
}

export class PaymentNotFoundError extends Error {
  constructor() {
    super('Payment not found');
  }
}

export class PaymentNotRetryableError extends Error {
  constructor(
    readonly reason: Extract<RetryEligibility, { eligible: false }>['reason'],
  ) {
    super(`Payment cannot be retried: ${reason}`);
  }
}

// A payment and its attempt disagreed during an outcome update; the transaction is rolled back.
export class PaymentStateConflictError extends Error {
  constructor(readonly paymentId: string) {
    super(`Payment ${paymentId} was not in a state that allows this outcome`);
  }
}
