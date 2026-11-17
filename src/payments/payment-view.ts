import type { Prisma } from '../generated/prisma/client.js';
import {
  PaymentActionStatus,
  PaymentActionType,
  PaymentStatus,
  RefundStatus,
} from '../generated/prisma/enums.js';
import type { PaymentResponse } from './payment.responses.js';

// What a payment's merchant-facing representation is built from, wherever it is returned or sent.
export const PAYMENT_VIEW_INCLUDE = {
  attempts: { orderBy: { attemptNumber: 'asc' } },
  refunds: {
    where: { status: RefundStatus.SUCCEEDED },
    select: { amount: true },
  },
  actions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.PaymentInclude;

export type PaymentViewRecord = Prisma.PaymentGetPayload<{
  include: typeof PAYMENT_VIEW_INCLUDE;
}>;

// The same record, for use inside an interactive transaction: an include of several relations
// makes Prisma load them concurrently, which a transaction's single connection cannot serve.
export async function loadPaymentView(
  db: Prisma.TransactionClient,
  paymentId: string,
): Promise<PaymentViewRecord> {
  const payment = await db.payment.findUniqueOrThrow({
    where: { id: paymentId },
  });
  const attempts = await db.paymentAttempt.findMany({
    where: { paymentId },
    orderBy: { attemptNumber: 'asc' },
  });
  const refunds = await db.refund.findMany({
    where: { paymentId, status: RefundStatus.SUCCEEDED },
    select: { amount: true },
  });
  const actions = await db.paymentAction.findMany({
    where: { paymentId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return { ...payment, attempts, refunds, actions };
}

// What a succeeded payment actually charged: the whole amount with automatic capture, the
// succeeded capture's amount with manual capture. Null until the payment has SUCCEEDED.
export function capturedAmount(payment: {
  status: PaymentStatus;
  amount: bigint;
  actions: readonly {
    type: PaymentActionType;
    status: PaymentActionStatus;
    amount: bigint | null;
  }[];
}): bigint | null {
  if (payment.status !== PaymentStatus.SUCCEEDED) return null;
  const capture = payment.actions.find(
    (action) =>
      action.type === PaymentActionType.CAPTURE &&
      action.status === PaymentActionStatus.SUCCEEDED,
  );
  return capture?.amount ?? payment.amount;
}

export function toPaymentResponse(payment: PaymentViewRecord): PaymentResponse {
  const latest = payment.attempts.at(-1);
  const captured = capturedAmount(payment);
  return {
    id: payment.id,
    amount: Number(payment.amount),
    currency: payment.currency,
    status: payment.status,
    captureMethod: payment.captureMethod,
    reference: payment.reference,
    failureCode:
      payment.status === PaymentStatus.FAILED
        ? (latest?.failureCode ?? null)
        : null,
    amountCaptured: captured === null ? null : Number(captured),
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
    actions: payment.actions.map((action) => ({
      id: action.id,
      type: action.type,
      amount: action.amount === null ? null : Number(action.amount),
      status: action.status,
      providerReference: action.providerReference,
      failureCode: action.failureCode,
      createdAt: action.createdAt,
      completedAt: action.completedAt,
    })),
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}
