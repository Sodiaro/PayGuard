import {
  PaymentAttemptStatus,
  PaymentStatus,
  RefundFailureCode,
  RefundStatus,
} from '../generated/prisma/enums.js';
import type { ProviderRefundResult } from '../payments/providers/payment-provider.js';

// Every refund status write is a conditional update whose WHERE clause is derived from this table.
// FAILED is terminal: a merchant refunds again with a new refund, which frees nothing twice.
export const REFUND_TRANSITIONS: Readonly<
  Record<RefundStatus, readonly RefundStatus[]>
> = {
  [RefundStatus.PENDING]: [RefundStatus.SUCCEEDED, RefundStatus.FAILED],
  [RefundStatus.SUCCEEDED]: [],
  [RefundStatus.FAILED]: [],
};

export function refundStatusesThatCanBecome(to: RefundStatus): RefundStatus[] {
  return Object.values(RefundStatus).filter((from) =>
    REFUND_TRANSITIONS[from].includes(to),
  );
}

export interface RefundResolution {
  status: RefundStatus;
  providerReference: string | null;
  failureCode: RefundFailureCode | null;
}

// "Unavailable" means the provider refused the refund without processing it, never a decline.
export function resolveRefund(result: ProviderRefundResult): RefundResolution {
  switch (result.outcome) {
    case 'succeeded':
      return {
        status: RefundStatus.SUCCEEDED,
        providerReference: result.providerReference,
        failureCode: null,
      };
    case 'declined':
      return {
        status: RefundStatus.FAILED,
        providerReference: result.providerReference,
        failureCode: RefundFailureCode.DECLINED,
      };
    case 'unavailable':
      return {
        status: RefundStatus.FAILED,
        providerReference: null,
        failureCode: RefundFailureCode.PROVIDER_UNAVAILABLE,
      };
    default: {
      const unexpected: never = result;
      throw new Error(
        `Unrecognised provider outcome: ${JSON.stringify((unexpected as { outcome?: unknown }).outcome)}`,
      );
    }
  }
}

export interface RecordedRefundOutcome {
  status: RefundStatus;
  failureCode: RefundFailureCode | null;
  providerReference: string | null;
}

// Whether a provider answer agrees with the outcome already recorded. A recorded outcome without a
// provider reference (the provider refused the refund) matches on status alone.
export function matchesRecordedRefund(
  recorded: RecordedRefundOutcome,
  resolution: RefundResolution,
): boolean {
  return (
    recorded.status === resolution.status &&
    recorded.failureCode === resolution.failureCode &&
    (recorded.providerReference === null ||
      recorded.providerReference === resolution.providerReference)
  );
}

// Pending refunds count against the payment: their money may already be on its way back.
const COMMITTED_REFUND_STATUSES: ReadonlySet<RefundStatus> = new Set([
  RefundStatus.PENDING,
  RefundStatus.SUCCEEDED,
]);

export function refundableAmount(
  payment: { amount: bigint },
  refunds: readonly { amount: bigint; status: RefundStatus }[],
): bigint {
  const committed = refunds
    .filter((refund) => COMMITTED_REFUND_STATUSES.has(refund.status))
    .reduce((total, refund) => total + refund.amount, 0n);
  return payment.amount - committed;
}

export type RefundEligibility =
  | { eligible: true; amount: bigint; attemptId: string }
  | {
      eligible: false;
      reason:
        | 'payment_not_succeeded'
        | 'nothing_left_to_refund'
        | 'amount_exceeds_refundable';
    };

// With no amount, the whole remaining refundable amount is refunded.
export function refundEligibility(
  payment: { status: PaymentStatus; amount: bigint },
  attempts: readonly { id: string; status: PaymentAttemptStatus }[],
  refunds: readonly { amount: bigint; status: RefundStatus }[],
  requestedAmount: bigint | null,
): RefundEligibility {
  const charge = attempts.find(
    (attempt) => attempt.status === PaymentAttemptStatus.SUCCEEDED,
  );
  if (payment.status !== PaymentStatus.SUCCEEDED || !charge) {
    return { eligible: false, reason: 'payment_not_succeeded' };
  }
  const refundable = refundableAmount(payment, refunds);
  if (refundable <= 0n) {
    return { eligible: false, reason: 'nothing_left_to_refund' };
  }
  const amount = requestedAmount ?? refundable;
  if (amount > refundable) {
    return { eligible: false, reason: 'amount_exceeds_refundable' };
  }
  return { eligible: true, amount, attemptId: charge.id };
}
