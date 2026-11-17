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
  // false: authorize only (manual capture); the provider answers `authorized` instead of `succeeded`.
  capture: boolean;
}

// Only definite answers are results. A thrown error or a timeout means the outcome is unknown:
// the provider may or may not have processed the payment. Callers record only a sanitized
// category for thrown errors, never their content.
export type ProviderPaymentResult =
  | { outcome: 'succeeded'; providerReference: string }
  | { outcome: 'authorized'; providerReference: string }
  | { outcome: 'declined'; providerReference: string | null }
  | { outcome: 'unavailable' };

export interface ProviderLookupRequest {
  attemptId: string;
  capture: boolean;
}

// `not_found` must mean the provider has no record of the attempt, so it is safe to submit it
// again under the same attempt ID. `unavailable` means the lookup itself could not be answered.
export type ProviderLookupResult =
  | { status: 'succeeded'; providerReference: string }
  | { status: 'authorized'; providerReference: string }
  | { status: 'declined'; providerReference: string | null }
  | { status: 'processing' }
  | { status: 'not_found' }
  | { status: 'unavailable' };

export interface ProviderRefundRequest {
  // Sent as the provider's idempotency key for the refund, like attemptId for payments.
  refundId: string;
  // The charge being refunded: the succeeded attempt and the provider's reference for it.
  attemptId: string;
  providerReference: string;
  amount: number;
  currency: string;
}

// The same contract as payments: only definite answers are results, and anything thrown or timed
// out leaves the refund's outcome unknown.
export type ProviderRefundResult = ProviderActionResult;

export interface ProviderRefundLookupRequest {
  refundId: string;
}

export type ProviderRefundLookupResult = ProviderActionLookupResult;

// Capturing or voiding an authorization. actionId is the provider's idempotency key for the action.
export interface ProviderCaptureRequest {
  actionId: string;
  attemptId: string;
  providerReference: string;
  // At most the authorized amount; any remainder is released.
  amount: number;
  currency: string;
}

export interface ProviderVoidRequest {
  actionId: string;
  attemptId: string;
  providerReference: string;
}

// `succeeded` means the capture or void took effect; `declined` that the provider refused it (for
// example an expired authorization), leaving the authorization as it was.
export type ProviderActionResult =
  | { outcome: 'succeeded'; providerReference: string }
  | { outcome: 'declined'; providerReference: string | null }
  | { outcome: 'unavailable' };

export interface ProviderActionLookupRequest {
  actionId: string;
  type: 'capture' | 'void';
}

export type ProviderActionLookupResult =
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
  processRefund(request: ProviderRefundRequest): Promise<ProviderRefundResult>;
  lookupRefund(
    request: ProviderRefundLookupRequest,
  ): Promise<ProviderRefundLookupResult>;
  capturePayment(
    request: ProviderCaptureRequest,
  ): Promise<ProviderActionResult>;
  voidPayment(request: ProviderVoidRequest): Promise<ProviderActionResult>;
  lookupPaymentAction(
    request: ProviderActionLookupRequest,
  ): Promise<ProviderActionLookupResult>;
}
