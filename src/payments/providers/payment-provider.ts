export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

// Providers PAYMENT_PROVIDER can select. The simulator is the only implementation and is refused
// in production (see src/config/environment.ts).
export enum PaymentProviderName {
  Simulator = 'simulator',
}

export const PROVIDER_CALL_TIMEOUT_MS = 10_000;

export class ProviderTimeoutError extends Error {
  constructor() {
    super('Payment provider did not answer in time');
  }
}

export function withProviderTimeout<T>(call: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ProviderTimeoutError()),
      PROVIDER_CALL_TIMEOUT_MS,
    ).unref();
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

export interface ProviderPaymentRequest {
  // Sent as the provider's idempotency key, so this exact attempt can be safely queried or resubmitted.
  attemptId: string;
  merchantId: string;
  amount: number;
  currency: string;
}

// Only definite answers are results. A thrown error or a timeout means the outcome is unknown:
// the provider may or may not have processed the payment. Callers record only a sanitized
// category for thrown errors, never their content.
export type ProviderPaymentResult =
  | { outcome: 'succeeded'; providerReference: string }
  | { outcome: 'declined'; providerReference: string | null }
  | { outcome: 'unavailable' };

export interface ProviderLookupRequest {
  attemptId: string;
}

// `not_found` must mean the provider has no record of the attempt, so it is safe to submit it
// again under the same attempt ID. `unavailable` means the lookup itself could not be answered.
export type ProviderLookupResult =
  | { status: 'succeeded'; providerReference: string }
  | { status: 'declined'; providerReference: string | null }
  | { status: 'processing' }
  | { status: 'not_found' }
  | { status: 'unavailable' };

export interface PaymentProvider {
  readonly id: string;
  processPayment(
    request: ProviderPaymentRequest,
  ): Promise<ProviderPaymentResult>;
  lookupPayment(request: ProviderLookupRequest): Promise<ProviderLookupResult>;
}
