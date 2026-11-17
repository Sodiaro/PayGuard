import { createHash } from 'node:crypto';
import {
  ProviderTimeoutError,
  type PaymentProvider,
  type ProviderLookupRequest,
  type ProviderLookupResult,
  type ProviderPaymentRequest,
  type ProviderPaymentResult,
  type ProviderRefundLookupRequest,
  type ProviderRefundLookupResult,
  type ProviderRefundRequest,
  type ProviderRefundResult,
} from './payment-provider.js';

export enum SimulatorOutcome {
  Succeeded = 'SUCCEEDED',
  Declined = 'DECLINED',
  Unavailable = 'UNAVAILABLE',
}

// The outcome comes from operator configuration, never from the merchant's request. The simulated
// ledger is a pure function of that configuration and the attempt or refund ID, so lookups give
// the same answer after a restart; it assumes everything it is asked about was submitted.
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly id = 'simulator';

  // With ambiguousSubmissions, every submission (payment or refund) is processed but its answer
  // is lost to a timeout, leaving the outcome to be recovered through a lookup.
  constructor(
    private readonly outcome: SimulatorOutcome,
    private readonly ambiguousSubmissions = false,
    private readonly refundOutcome = SimulatorOutcome.Succeeded,
  ) {}

  processPayment(
    request: ProviderPaymentRequest,
  ): Promise<ProviderPaymentResult> {
    if (this.ambiguousSubmissions) {
      return Promise.reject(new ProviderTimeoutError());
    }
    return Promise.resolve(
      submissionResult(this.outcome, referenceFor(request.attemptId)),
    );
  }

  lookupPayment(request: ProviderLookupRequest): Promise<ProviderLookupResult> {
    return Promise.resolve(
      lookupResult(this.outcome, referenceFor(request.attemptId)),
    );
  }

  processRefund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    if (this.ambiguousSubmissions) {
      return Promise.reject(new ProviderTimeoutError());
    }
    return Promise.resolve(
      submissionResult(
        this.refundOutcome,
        refundReferenceFor(request.refundId),
      ),
    );
  }

  lookupRefund(
    request: ProviderRefundLookupRequest,
  ): Promise<ProviderRefundLookupResult> {
    return Promise.resolve(
      lookupResult(this.refundOutcome, refundReferenceFor(request.refundId)),
    );
  }
}

function submissionResult(
  outcome: SimulatorOutcome,
  providerReference: string,
): ProviderPaymentResult {
  switch (outcome) {
    case SimulatorOutcome.Succeeded:
      return { outcome: 'succeeded', providerReference };
    case SimulatorOutcome.Declined:
      return { outcome: 'declined', providerReference };
    case SimulatorOutcome.Unavailable:
      return { outcome: 'unavailable' };
  }
}

function lookupResult(
  outcome: SimulatorOutcome,
  providerReference: string,
): ProviderLookupResult {
  switch (outcome) {
    case SimulatorOutcome.Succeeded:
      return { status: 'succeeded', providerReference };
    case SimulatorOutcome.Declined:
      return { status: 'declined', providerReference };
    case SimulatorOutcome.Unavailable:
      return { status: 'not_found' };
  }
}

export function referenceFor(attemptId: string): string {
  return `sim_${createHash('sha256').update(attemptId).digest('hex').slice(0, 24)}`;
}

export function refundReferenceFor(refundId: string): string {
  return `simrf_${createHash('sha256').update(refundId).digest('hex').slice(0, 24)}`;
}
