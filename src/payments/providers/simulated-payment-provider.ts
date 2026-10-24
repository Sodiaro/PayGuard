import { createHash } from 'node:crypto';
import type {
  PaymentProvider,
  ProviderPaymentRequest,
  ProviderPaymentResult,
} from './payment-provider.js';

export enum SimulatorOutcome {
  Succeeded = 'SUCCEEDED',
  Declined = 'DECLINED',
  Unavailable = 'UNAVAILABLE',
}

// The outcome comes from operator configuration, never from the merchant's request.
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly id = 'simulator';

  constructor(private readonly outcome: SimulatorOutcome) {}

  processPayment(
    request: ProviderPaymentRequest,
  ): Promise<ProviderPaymentResult> {
    const providerReference = `sim_${createHash('sha256').update(request.attemptId).digest('hex').slice(0, 24)}`;

    switch (this.outcome) {
      case SimulatorOutcome.Succeeded:
        return Promise.resolve({ outcome: 'succeeded', providerReference });
      case SimulatorOutcome.Declined:
        return Promise.resolve({ outcome: 'declined', providerReference });
      case SimulatorOutcome.Unavailable:
        return Promise.resolve({ outcome: 'unavailable' });
    }
  }
}
