import {
  ProviderTimeoutError,
  type PaymentProvider,
  type ProviderLookupRequest,
  type ProviderLookupResult,
  type ProviderPaymentRequest,
  type ProviderPaymentResult,
} from '../../src/payments/providers/payment-provider.js';
import {
  SimulatedPaymentProvider,
  SimulatorOutcome,
} from '../../src/payments/providers/simulated-payment-provider.js';

type Submission = (
  request: ProviderPaymentRequest,
) => Promise<ProviderPaymentResult>;

// A provider double with a ledger of attempts it has actually processed. Tests choose how a
// submission behaves (answer, process-then-time-out, fail without processing, hold open) and what
// lookups return, and can assert exactly how often each operation was invoked.
export class ScriptedProvider implements PaymentProvider {
  readonly id = 'simulator';
  submissions: ProviderPaymentRequest[] = [];
  lookups: ProviderLookupRequest[] = [];
  readonly ledger = new Map<string, ProviderPaymentResult>();
  private submission: Submission = this.processing(SimulatorOutcome.Succeeded);
  private scriptedLookups: (ProviderLookupResult | Error)[] = [];

  reset(): void {
    this.submissions = [];
    this.lookups = [];
    this.ledger.clear();
    this.scriptedLookups = [];
    this.submission = this.processing(SimulatorOutcome.Succeeded);
  }

  willReturn(outcome: SimulatorOutcome): void {
    this.submission = this.processing(outcome);
  }

  // The provider processes the payment but its answer never arrives.
  willProcessThenTimeOut(outcome: SimulatorOutcome): void {
    const process = this.processing(outcome);
    this.submission = async (request) => {
      await process(request);
      throw new ProviderTimeoutError();
    };
  }

  // The request fails before the provider processes anything.
  willThrow(error: Error): void {
    this.submission = () => Promise.reject(error);
  }

  willAnswer(result: unknown): void {
    this.submission = () => Promise.resolve(result as ProviderPaymentResult);
  }

  // Lookups return these answers in order, then fall back to the ledger.
  willLookup(...answers: (ProviderLookupResult | Error)[]): void {
    this.scriptedLookups.push(...answers);
  }

  // The next submission is processed immediately but its answer is held until release().
  hold(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (markEntered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const next = this.submission;
    this.submission = async (request) => {
      const settled = next(request).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      markEntered();
      await gate;
      const outcome = await settled;
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    };
    return { entered, release };
  }

  processPayment(
    request: ProviderPaymentRequest,
  ): Promise<ProviderPaymentResult> {
    this.submissions.push(request);
    return this.submission(request);
  }

  lookupPayment(request: ProviderLookupRequest): Promise<ProviderLookupResult> {
    this.lookups.push(request);
    const scripted = this.scriptedLookups.shift();
    if (scripted instanceof Error) return Promise.reject(scripted);
    if (scripted) return Promise.resolve(scripted);

    const recorded = this.ledger.get(request.attemptId);
    if (!recorded || recorded.outcome === 'unavailable') {
      return Promise.resolve({ status: 'not_found' });
    }
    return Promise.resolve(
      recorded.outcome === 'succeeded'
        ? { status: 'succeeded', providerReference: recorded.providerReference }
        : { status: 'declined', providerReference: recorded.providerReference },
    );
  }

  private processing(outcome: SimulatorOutcome): Submission {
    const simulator = new SimulatedPaymentProvider(outcome);
    return async (request) => {
      const result = await simulator.processPayment(request);
      if (result.outcome !== 'unavailable') {
        this.ledger.set(request.attemptId, result);
      }
      return result;
    };
  }
}
