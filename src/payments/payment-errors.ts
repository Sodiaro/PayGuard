export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super(
      'Idempotency-Key has already been used with a different request; use a new key for a new payment',
    );
  }
}

// A payment and its attempt disagreed during an outcome update; the transaction is rolled back.
export class PaymentStateConflictError extends Error {
  constructor(readonly paymentId: string) {
    super(`Payment ${paymentId} was not in a state that allows this outcome`);
  }
}

export class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Payment provider did not answer within ${timeoutMs}ms`);
  }
}
