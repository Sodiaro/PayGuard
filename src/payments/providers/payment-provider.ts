export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface ProviderPaymentRequest {
  // Sent as the provider's idempotency key, so this exact attempt can be safely queried or resubmitted.
  attemptId: string;
  merchantId: string;
  amount: number;
  currency: string;
}

// Only definite answers are results. Anything else (a thrown error, a timeout) means the outcome
// is unknown: the provider may or may not have processed the payment. Thrown errors are logged
// server-side, so adapters must strip credentials and raw provider payloads from them.
export type ProviderPaymentResult =
  | { outcome: 'succeeded'; providerReference: string }
  | { outcome: 'declined'; providerReference: string | null }
  | { outcome: 'unavailable' };

export interface PaymentProvider {
  readonly id: string;
  processPayment(
    request: ProviderPaymentRequest,
  ): Promise<ProviderPaymentResult>;
}
