import type {
  PaymentProvider,
  ProviderPaymentRequest,
  ProviderPaymentResult,
} from '../../src/payments/providers/payment-provider.js';
import {
  SimulatedPaymentProvider,
  SimulatorOutcome,
} from '../../src/payments/providers/simulated-payment-provider.js';

type Behaviour = (
  request: ProviderPaymentRequest,
) => Promise<ProviderPaymentResult>;

const simulate =
  (outcome: SimulatorOutcome): Behaviour =>
  (request) =>
    new SimulatedPaymentProvider(outcome).processPayment(request);

// Wraps the real simulator so tests can count provider calls, choose outcomes, inject failures
// and hold a call open, without sleeps or timing assumptions.
export class ScriptedProvider implements PaymentProvider {
  readonly id = 'simulator';
  calls: ProviderPaymentRequest[] = [];
  private behaviour: Behaviour = simulate(SimulatorOutcome.Succeeded);

  reset(): void {
    this.calls = [];
    this.behaviour = simulate(SimulatorOutcome.Succeeded);
  }

  willReturn(outcome: SimulatorOutcome): void {
    this.behaviour = simulate(outcome);
  }

  willThrow(error: Error): void {
    this.behaviour = () => Promise.reject(error);
  }

  willAnswer(result: unknown): void {
    this.behaviour = () => Promise.resolve(result as ProviderPaymentResult);
  }

  // The next call blocks until release(); `entered` resolves once the call has started.
  hold(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (markEntered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const next = this.behaviour;
    this.behaviour = async (request) => {
      markEntered();
      await gate;
      return next(request);
    };
    return { entered, release };
  }

  processPayment(
    request: ProviderPaymentRequest,
  ): Promise<ProviderPaymentResult> {
    this.calls.push(request);
    return this.behaviour(request);
  }
}
