import type { Prisma } from '../generated/prisma/client.js';
import { PaymentStateConflictError } from './payment-errors.js';
import {
  attemptStatusesThatCanBecome,
  paymentStatusesThatCanBecome,
  type AttemptResolution,
} from './payment-lifecycle.js';

// Applies a definite outcome to an attempt and its payment within the caller's transaction.
// Returns false when the attempt already has an outcome, so a late, duplicate or racing result
// never overwrites a terminal state.
export async function applyAttemptResolution(
  tx: Prisma.TransactionClient,
  attemptId: string,
  resolution: AttemptResolution,
): Promise<boolean> {
  const attempt = await tx.paymentAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: attemptStatusesThatCanBecome(resolution.attemptStatus) },
    },
    data: {
      status: resolution.attemptStatus,
      providerReference: resolution.providerReference,
      failureCode: resolution.failureCode,
      completedAt: new Date(),
    },
  });
  if (attempt.count === 0) return false;

  const { paymentId } = await tx.paymentAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { paymentId: true },
  });
  const payment = await tx.payment.updateMany({
    where: {
      id: paymentId,
      status: { in: paymentStatusesThatCanBecome(resolution.paymentStatus) },
    },
    data: { status: resolution.paymentStatus },
  });
  if (payment.count !== 1) throw new PaymentStateConflictError(paymentId);
  return true;
}
