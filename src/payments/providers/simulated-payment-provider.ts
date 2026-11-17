import { createHash } from 'node:crypto';
import {
  ProviderTimeoutError,
  type PaymentProvider,
  type ProviderActionLookupRequest,
  type ProviderActionLookupResult,
  type ProviderActionResult,
  type ProviderCaptureRequest,
  type ProviderLookupRequest,
  type ProviderLookupResult,
  type ProviderPaymentRequest,
  type ProviderPaymentResult,
  type ProviderPayoutLookupRequest,
  type ProviderPayoutLookupResult,
  type ProviderPayoutRequest,
  type ProviderPayoutResult,
  type ProviderRefundLookupRequest,
  type ProviderRefundLookupResult,
  type ProviderRefundRequest,
  type ProviderRefundResult,
  type ProviderVoidRequest,
} from './payment-provider.js';

export enum SimulatorOutcome {
  Succeeded = 'SUCCEEDED',
  Declined = 'DECLINED',
  Unavailable = 'UNAVAILABLE',
}

export interface SimulatorOutcomes {
  payment: SimulatorOutcome;
  refund?: SimulatorOutcome;
  // Captures and voids of authorizations.
  action?: SimulatorOutcome;
  payout?: SimulatorOutcome;
}

// The outcome comes from operator configuration, never from the merchant's request. The simulated
// ledger is a pure function of that configuration and the attempt, refund, action or payout ID, so
// lookups give the same answer after a restart; it assumes everything it is asked about was
// submitted.
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly id = 'simulator';
  private readonly paymentOutcome: SimulatorOutcome;
  private readonly refundOutcome: SimulatorOutcome;
  private readonly actionOutcome: SimulatorOutcome;
  private readonly payoutOutcome: SimulatorOutcome;

  // With ambiguousSubmissions, every submission (payment, refund, capture, void or payout) is
  // processed but its answer is lost to a timeout, leaving the outcome to a lookup.
  constructor(
    outcomes: SimulatorOutcome | SimulatorOutcomes,
    private readonly ambiguousSubmissions = false,
  ) {
    const resolved =
      typeof outcomes === 'string' ? { payment: outcomes } : outcomes;
    this.paymentOutcome = resolved.payment;
    this.refundOutcome = resolved.refund ?? SimulatorOutcome.Succeeded;
    this.actionOutcome = resolved.action ?? SimulatorOutcome.Succeeded;
    this.payoutOutcome = resolved.payout ?? SimulatorOutcome.Succeeded;
  }

  processPayment(
    request: ProviderPaymentRequest,
  ): Promise<ProviderPaymentResult> {
    if (this.ambiguousSubmissions) {
      return Promise.reject(new ProviderTimeoutError());
    }
    const result = submissionResult(
      this.paymentOutcome,
      referenceFor(request.attemptId),
    );
    return Promise.resolve(
      result.outcome === 'succeeded' && !request.capture
        ? { outcome: 'authorized', providerReference: result.providerReference }
        : result,
    );
  }

  lookupPayment(request: ProviderLookupRequest): Promise<ProviderLookupResult> {
    const result = lookupResult(
      this.paymentOutcome,
      referenceFor(request.attemptId),
    );
    return Promise.resolve(
      result.status === 'succeeded' && !request.capture
        ? { status: 'authorized', providerReference: result.providerReference }
        : result,
    );
  }

  processRefund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return this.submitAction(
      this.refundOutcome,
      refundReferenceFor(request.refundId),
    );
  }

  lookupRefund(
    request: ProviderRefundLookupRequest,
  ): Promise<ProviderRefundLookupResult> {
    return Promise.resolve(
      lookupResult(this.refundOutcome, refundReferenceFor(request.refundId)),
    );
  }

  capturePayment(
    request: ProviderCaptureRequest,
  ): Promise<ProviderActionResult> {
    return this.submitAction(
      this.actionOutcome,
      actionReferenceFor(request.actionId, 'capture'),
    );
  }

  voidPayment(request: ProviderVoidRequest): Promise<ProviderActionResult> {
    return this.submitAction(
      this.actionOutcome,
      actionReferenceFor(request.actionId, 'void'),
    );
  }

  lookupPaymentAction(
    request: ProviderActionLookupRequest,
  ): Promise<ProviderActionLookupResult> {
    return Promise.resolve(
      lookupResult(
        this.actionOutcome,
        actionReferenceFor(request.actionId, request.type),
      ),
    );
  }

  processPayout(request: ProviderPayoutRequest): Promise<ProviderPayoutResult> {
    return this.submitAction(
      this.payoutOutcome,
      payoutReferenceFor(request.payoutId),
    );
  }

  lookupPayout(
    request: ProviderPayoutLookupRequest,
  ): Promise<ProviderPayoutLookupResult> {
    return Promise.resolve(
      lookupResult(this.payoutOutcome, payoutReferenceFor(request.payoutId)),
    );
  }

  private submitAction(
    outcome: SimulatorOutcome,
    providerReference: string,
  ): Promise<ProviderActionResult> {
    if (this.ambiguousSubmissions) {
      return Promise.reject(new ProviderTimeoutError());
    }
    return Promise.resolve(submissionResult(outcome, providerReference));
  }
}

function submissionResult(
  outcome: SimulatorOutcome,
  providerReference: string,
): ProviderActionResult {
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
): ProviderActionLookupResult {
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

export function actionReferenceFor(
  actionId: string,
  type: 'capture' | 'void',
): string {
  const prefix = type === 'capture' ? 'simcp' : 'simvd';
  return `${prefix}_${createHash('sha256').update(actionId).digest('hex').slice(0, 24)}`;
}

export function payoutReferenceFor(payoutId: string): string {
  return `simpo_${createHash('sha256').update(payoutId).digest('hex').slice(0, 24)}`;
}
