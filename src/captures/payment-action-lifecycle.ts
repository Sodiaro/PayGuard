import {
  CaptureMethod,
  PaymentActionFailureCode,
  PaymentActionStatus,
  PaymentActionType,
  PaymentAttemptStatus,
  PaymentStatus,
} from '../generated/prisma/enums.js';
import type { ProviderActionResult } from '../payments/providers/payment-provider.js';

// Every action status write is a conditional update derived from this table. A failed capture or
// void leaves the authorization as it was, so the merchant may try again with a new action.
export const PAYMENT_ACTION_TRANSITIONS: Readonly<
  Record<PaymentActionStatus, readonly PaymentActionStatus[]>
> = {
  [PaymentActionStatus.PENDING]: [
    PaymentActionStatus.SUCCEEDED,
    PaymentActionStatus.FAILED,
  ],
  [PaymentActionStatus.SUCCEEDED]: [],
  [PaymentActionStatus.FAILED]: [],
};

export function actionStatusesThatCanBecome(
  to: PaymentActionStatus,
): PaymentActionStatus[] {
  return Object.values(PaymentActionStatus).filter((from) =>
    PAYMENT_ACTION_TRANSITIONS[from].includes(to),
  );
}

// What a succeeded action does to its AUTHORIZED payment.
export const PAYMENT_STATUS_AFTER: Readonly<
  Record<PaymentActionType, PaymentStatus>
> = {
  [PaymentActionType.CAPTURE]: PaymentStatus.SUCCEEDED,
  [PaymentActionType.VOID]: PaymentStatus.CANCELED,
};

export interface ActionResolution {
  status: PaymentActionStatus;
  providerReference: string | null;
  failureCode: PaymentActionFailureCode | null;
}

// "Unavailable" means the provider refused the action without processing it, never a decline.
export function resolveAction(result: ProviderActionResult): ActionResolution {
  switch (result.outcome) {
    case 'succeeded':
      return {
        status: PaymentActionStatus.SUCCEEDED,
        providerReference: result.providerReference,
        failureCode: null,
      };
    case 'declined':
      return {
        status: PaymentActionStatus.FAILED,
        providerReference: result.providerReference,
        failureCode: PaymentActionFailureCode.DECLINED,
      };
    case 'unavailable':
      return {
        status: PaymentActionStatus.FAILED,
        providerReference: null,
        failureCode: PaymentActionFailureCode.PROVIDER_UNAVAILABLE,
      };
    default: {
      const unexpected: never = result;
      throw new Error(
        `Unrecognised provider outcome: ${JSON.stringify((unexpected as { outcome?: unknown }).outcome)}`,
      );
    }
  }
}

export function matchesRecordedAction(
  recorded: ActionResolution,
  resolution: ActionResolution,
): boolean {
  return (
    recorded.status === resolution.status &&
    recorded.failureCode === resolution.failureCode &&
    (recorded.providerReference === null ||
      recorded.providerReference === resolution.providerReference)
  );
}

export type ActionEligibility =
  | { eligible: true; attemptId: string; amount: bigint | null }
  | {
      eligible: false;
      reason:
        | 'payment_not_authorized'
        | 'action_in_progress'
        | 'amount_exceeds_authorized';
    };

// A capture without an amount captures the whole authorization.
export function actionEligibility(
  payment: {
    status: PaymentStatus;
    captureMethod: CaptureMethod;
    amount: bigint;
  },
  attempts: readonly { id: string; status: PaymentAttemptStatus }[],
  actions: readonly { status: PaymentActionStatus }[],
  type: PaymentActionType,
  requestedAmount: bigint | null,
): ActionEligibility {
  const authorization = attempts.find(
    (attempt) => attempt.status === PaymentAttemptStatus.SUCCEEDED,
  );
  if (
    payment.captureMethod !== CaptureMethod.MANUAL ||
    payment.status !== PaymentStatus.AUTHORIZED ||
    !authorization
  ) {
    return { eligible: false, reason: 'payment_not_authorized' };
  }
  if (actions.some((action) => action.status === PaymentActionStatus.PENDING)) {
    return { eligible: false, reason: 'action_in_progress' };
  }
  if (type === PaymentActionType.VOID) {
    return { eligible: true, attemptId: authorization.id, amount: null };
  }
  const amount = requestedAmount ?? payment.amount;
  if (amount > payment.amount) {
    return { eligible: false, reason: 'amount_exceeds_authorized' };
  }
  return { eligible: true, attemptId: authorization.id, amount };
}
