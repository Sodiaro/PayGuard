import type { Prisma } from '../generated/prisma/client.js';
import { PaymentStatus, RefundStatus } from '../generated/prisma/enums.js';
import type { PaymentResponse } from './payment.responses.js';

// What a payment's merchant-facing representation is built from, wherever it is returned or sent.
export const PAYMENT_VIEW_INCLUDE = {
  attempts: { orderBy: { attemptNumber: 'asc' } },
  refunds: {
    where: { status: RefundStatus.SUCCEEDED },
    select: { amount: true },
  },
} satisfies Prisma.PaymentInclude;

export type PaymentViewRecord = Prisma.PaymentGetPayload<{
  include: typeof PAYMENT_VIEW_INCLUDE;
}>;

export function toPaymentResponse(payment: PaymentViewRecord): PaymentResponse {
  const latest = payment.attempts.at(-1);
  return {
    id: payment.id,
    amount: Number(payment.amount),
    currency: payment.currency,
    status: payment.status,
    reference: payment.reference,
    failureCode:
      payment.status === PaymentStatus.FAILED
        ? (latest?.failureCode ?? null)
        : null,
    amountRefunded: Number(
      payment.refunds.reduce((total, refund) => total + refund.amount, 0n),
    ),
    attempts: payment.attempts.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      provider: attempt.provider,
      status: attempt.status,
      providerReference: attempt.providerReference,
      failureCode: attempt.failureCode,
      createdAt: attempt.createdAt,
      completedAt: attempt.completedAt,
    })),
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}
