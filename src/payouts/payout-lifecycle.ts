import { PayoutFailureCode, PayoutStatus } from '../generated/prisma/enums.js';
import type { ProviderPayoutResult } from '../payments/providers/payment-provider.js';

// Every payout status write is a conditional update whose WHERE clause is derived from this table.
// FAILED is terminal and releases the amount back to the available balance.
export const PAYOUT_TRANSITIONS: Readonly<
  Record<PayoutStatus, readonly PayoutStatus[]>
> = {
  [PayoutStatus.PENDING]: [PayoutStatus.SUCCEEDED, PayoutStatus.FAILED],
  [PayoutStatus.SUCCEEDED]: [],
  [PayoutStatus.FAILED]: [],
};

export function payoutStatusesThatCanBecome(to: PayoutStatus): PayoutStatus[] {
  return Object.values(PayoutStatus).filter((from) =>
    PAYOUT_TRANSITIONS[from].includes(to),
  );
}

export interface PayoutResolution {
  status: PayoutStatus;
  providerReference: string | null;
  failureCode: PayoutFailureCode | null;
}

// "Unavailable" means the provider refused the payout without processing it, never a decline.
export function resolvePayout(result: ProviderPayoutResult): PayoutResolution {
  switch (result.outcome) {
    case 'succeeded':
      return {
        status: PayoutStatus.SUCCEEDED,
        providerReference: result.providerReference,
        failureCode: null,
      };
    case 'declined':
      return {
        status: PayoutStatus.FAILED,
        providerReference: result.providerReference,
        failureCode: PayoutFailureCode.DECLINED,
      };
    case 'unavailable':
      return {
        status: PayoutStatus.FAILED,
        providerReference: null,
        failureCode: PayoutFailureCode.PROVIDER_UNAVAILABLE,
      };
    default: {
      const unexpected: never = result;
      throw new Error(
        `Unrecognised provider outcome: ${JSON.stringify((unexpected as { outcome?: unknown }).outcome)}`,
      );
    }
  }
}

export interface RecordedPayoutOutcome {
  status: PayoutStatus;
  failureCode: PayoutFailureCode | null;
  providerReference: string | null;
}

// A recorded outcome without a provider reference (the provider refused the payout) matches on
// status alone.
export function matchesRecordedPayout(
  recorded: RecordedPayoutOutcome,
  resolution: PayoutResolution,
): boolean {
  return (
    recorded.status === resolution.status &&
    recorded.failureCode === resolution.failureCode &&
    (recorded.providerReference === null ||
      recorded.providerReference === resolution.providerReference)
  );
}
