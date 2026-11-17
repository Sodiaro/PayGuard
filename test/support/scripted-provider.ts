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
  type ProviderRefundLookupRequest,
  type ProviderRefundLookupResult,
  type ProviderRefundRequest,
  type ProviderRefundResult,
  type ProviderVoidRequest,
} from '../../src/payments/providers/payment-provider.js';
import {
  SimulatedPaymentProvider,
  SimulatorOutcome,
} from '../../src/payments/providers/simulated-payment-provider.js';

type Submission = (
  request: ProviderPaymentRequest,
) => Promise<ProviderPaymentResult>;

type RefundSubmission = (
  request: ProviderRefundRequest,
) => Promise<ProviderRefundResult>;

export type ActionRequest =
  | ({ type: 'capture' } & ProviderCaptureRequest)
  | ({ type: 'void' } & ProviderVoidRequest);

type ActionSubmission = (
  request: ActionRequest,
) => Promise<ProviderActionResult>;

// A provider double with ledgers of the attempts, refunds, captures and voids it has actually
// processed. Tests choose how a submission behaves (answer, process-then-time-out, fail without
// processing, hold open) and what lookups return, and can assert exactly how often each operation
// was invoked.
export class ScriptedProvider implements PaymentProvider {
  readonly id = 'simulator';
  submissions: ProviderPaymentRequest[] = [];
  lookups: ProviderLookupRequest[] = [];
  refundSubmissions: ProviderRefundRequest[] = [];
  refundLookups: ProviderRefundLookupRequest[] = [];
  actionSubmissions: ActionRequest[] = [];
  actionLookups: ProviderActionLookupRequest[] = [];
  readonly ledger = new Map<string, ProviderPaymentResult>();
  readonly refundLedger = new Map<string, ProviderRefundResult>();
  readonly actionLedger = new Map<string, ProviderActionResult>();
  private submission: Submission = this.processing(SimulatorOutcome.Succeeded);
  private refundSubmission: RefundSubmission = this.refunding(
    SimulatorOutcome.Succeeded,
  );
  private actionSubmission: ActionSubmission = this.acting(
    SimulatorOutcome.Succeeded,
  );
  private scriptedLookups: (ProviderLookupResult | Error)[] = [];
  private scriptedRefundLookups: (ProviderRefundLookupResult | Error)[] = [];
  private scriptedActionLookups: (ProviderActionLookupResult | Error)[] = [];

  reset(): void {
    this.submissions = [];
    this.lookups = [];
    this.refundSubmissions = [];
    this.refundLookups = [];
    this.actionSubmissions = [];
    this.actionLookups = [];
    this.ledger.clear();
    this.refundLedger.clear();
    this.actionLedger.clear();
    this.scriptedLookups = [];
    this.scriptedRefundLookups = [];
    this.scriptedActionLookups = [];
    this.submission = this.processing(SimulatorOutcome.Succeeded);
    this.refundSubmission = this.refunding(SimulatorOutcome.Succeeded);
    this.actionSubmission = this.acting(SimulatorOutcome.Succeeded);
  }

  willRefund(outcome: SimulatorOutcome): void {
    this.refundSubmission = this.refunding(outcome);
  }

  // The provider processes the refund but its answer never arrives.
  willRefundThenTimeOut(outcome: SimulatorOutcome): void {
    const refund = this.refunding(outcome);
    this.refundSubmission = async (request) => {
      await refund(request);
      throw new ProviderTimeoutError();
    };
  }

  // The refund request fails before the provider processes anything.
  willThrowOnRefund(error: Error): void {
    this.refundSubmission = () => Promise.reject(error);
  }

  // Refund lookups return these answers in order, then fall back to the refund ledger.
  willLookupRefund(...answers: (ProviderRefundLookupResult | Error)[]): void {
    this.scriptedRefundLookups.push(...answers);
  }

  processRefund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    this.refundSubmissions.push(request);
    return this.refundSubmission(request);
  }

  lookupRefund(
    request: ProviderRefundLookupRequest,
  ): Promise<ProviderRefundLookupResult> {
    this.refundLookups.push(request);
    const scripted = this.scriptedRefundLookups.shift();
    if (scripted instanceof Error) return Promise.reject(scripted);
    if (scripted) return Promise.resolve(scripted);
    return Promise.resolve(
      fromActionLedger(this.refundLedger.get(request.refundId)),
    );
  }

  // Captures and voids.
  willAct(outcome: SimulatorOutcome): void {
    this.actionSubmission = this.acting(outcome);
  }

  // The provider captures or voids but its answer never arrives.
  willActThenTimeOut(outcome: SimulatorOutcome): void {
    const act = this.acting(outcome);
    this.actionSubmission = async (request) => {
      await act(request);
      throw new ProviderTimeoutError();
    };
  }

  willThrowOnAction(error: Error): void {
    this.actionSubmission = () => Promise.reject(error);
  }

  willLookupAction(...answers: (ProviderActionLookupResult | Error)[]): void {
    this.scriptedActionLookups.push(...answers);
  }

  capturePayment(
    request: ProviderCaptureRequest,
  ): Promise<ProviderActionResult> {
    const entry: ActionRequest = { type: 'capture', ...request };
    this.actionSubmissions.push(entry);
    return this.actionSubmission(entry);
  }

  voidPayment(request: ProviderVoidRequest): Promise<ProviderActionResult> {
    const entry: ActionRequest = { type: 'void', ...request };
    this.actionSubmissions.push(entry);
    return this.actionSubmission(entry);
  }

  lookupPaymentAction(
    request: ProviderActionLookupRequest,
  ): Promise<ProviderActionLookupResult> {
    this.actionLookups.push(request);
    const scripted = this.scriptedActionLookups.shift();
    if (scripted instanceof Error) return Promise.reject(scripted);
    if (scripted) return Promise.resolve(scripted);
    return Promise.resolve(
      fromActionLedger(this.actionLedger.get(request.actionId)),
    );
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
    if (recorded?.outcome === 'authorized') {
      return Promise.resolve({
        status: 'authorized',
        providerReference: recorded.providerReference,
      });
    }
    return Promise.resolve(fromActionLedger(recorded));
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

  private refunding(outcome: SimulatorOutcome): RefundSubmission {
    const simulator = new SimulatedPaymentProvider({
      payment: SimulatorOutcome.Succeeded,
      refund: outcome,
    });
    return async (request) => {
      const result = await simulator.processRefund(request);
      if (result.outcome !== 'unavailable') {
        this.refundLedger.set(request.refundId, result);
      }
      return result;
    };
  }

  private acting(outcome: SimulatorOutcome): ActionSubmission {
    const simulator = new SimulatedPaymentProvider({
      payment: SimulatorOutcome.Succeeded,
      action: outcome,
    });
    return async (request) => {
      const result =
        request.type === 'capture'
          ? await simulator.capturePayment(request)
          : await simulator.voidPayment(request);
      if (result.outcome !== 'unavailable') {
        this.actionLedger.set(request.actionId, result);
      }
      return result;
    };
  }
}

function fromActionLedger(
  recorded:
    | ProviderActionResult
    | Exclude<ProviderPaymentResult, { outcome: 'authorized' }>
    | undefined,
): ProviderActionLookupResult {
  if (!recorded || recorded.outcome === 'unavailable') {
    return { status: 'not_found' };
  }
  return recorded.outcome === 'succeeded'
    ? { status: 'succeeded', providerReference: recorded.providerReference }
    : { status: 'declined', providerReference: recorded.providerReference };
}
