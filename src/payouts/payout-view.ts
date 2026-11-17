import type { Prisma } from '../generated/prisma/client.js';
import type { CurrencyBalance } from './balance.js';
import type {
  CurrencyBalanceResponse,
  PayoutResponse,
} from './payout.responses.js';

export function toPayoutResponse(
  payout: Prisma.PayoutGetPayload<object>,
): PayoutResponse {
  return {
    id: payout.id,
    amount: Number(payout.amount),
    currency: payout.currency,
    status: payout.status,
    destination: {
      bankCode: payout.bankCode,
      accountNumberLast4: payout.accountNumber.slice(-4),
      accountName: payout.accountName,
    },
    reference: payout.reference,
    providerReference: payout.providerReference,
    failureCode: payout.failureCode,
    createdAt: payout.createdAt,
    completedAt: payout.completedAt,
  };
}

export function toBalanceResponse(
  balance: CurrencyBalance,
): CurrencyBalanceResponse {
  return {
    currency: balance.currency,
    available: Number(balance.available),
    captured: Number(balance.captured),
    refunded: Number(balance.refunded),
    paidOut: Number(balance.paidOut),
    inTransit: Number(balance.inTransit),
  };
}
