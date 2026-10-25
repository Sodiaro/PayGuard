import { createHash } from 'node:crypto';
import {
  ProviderTimeoutError,
  type PaymentProvider,
  type ProviderLookupRequest,
  type ProviderLookupResult,
  type ProviderPaymentRequest,
  type ProviderPaymentResult,
} from './payment-provider.js';

export enum SimulatorOutcome {
  Succeeded = 'SUCCEEDED',
  Declined = 'DECLINED',
  Unavailable = 'UNAVAILABLE',
}

// The outcome comes from operator configuration, never from the merchant's request. The simulated
// ledger is a pure function of that configuration and the attempt ID, so lookups give the same
// answer after a restart; it assumes every attempt it is asked about was submitted.
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly id = 'simulator';

  // With ambiguousSubmissions, every submission is processed but its answer is lost to a timeout,
  // leaving the outcome to be recovered through lookupPayment.
  constructor(
    private readonly outcome: SimulatorOutcome,
    private readonly ambiguousSubmissions = false,
  ) {}

  processPayment(
    request: ProviderPaymentRequest,
  ): Promise<ProviderPaymentResult> {
    if (this.ambiguousSubmissions) {
      return Promise.reject(new ProviderTimeoutError());
    }

    switch (this.outcome) {
      case SimulatorOutcome.Succeeded:
        return Promise.resolve({
          outcome: 'succeeded',
          providerReference: referenceFor(request.attemptId),
        });
      case SimulatorOutcome.Declined:
        return Promise.resolve({
          outcome: 'declined',
          providerReference: referenceFor(request.attemptId),
        });
      case SimulatorOutcome.Unavailable:
        return Promise.resolve({ outcome: 'unavailable' });
    }
  }

  lookupPayment(request: ProviderLookupRequest): Promise<ProviderLookupResult> {
    switch (this.outcome) {
      case SimulatorOutcome.Succeeded:
        return Promise.resolve({
          status: 'succeeded',
          providerReference: referenceFor(request.attemptId),
        });
      case SimulatorOutcome.Declined:
        return Promise.resolve({
          status: 'declined',
          providerReference: referenceFor(request.attemptId),
        });
      case SimulatorOutcome.Unavailable:
        return Promise.resolve({ status: 'not_found' });
    }
  }
}

function referenceFor(attemptId: string): string {
  return `sim_${createHash('sha256').update(attemptId).digest('hex').slice(0, 24)}`;
}
