import type { Prisma } from '../generated/prisma/client.js';
import {
  PaymentStatus,
  type PaymentAttemptStatus,
  type PaymentEventSource,
  type PaymentFailureCode,
} from '../generated/prisma/enums.js';
import { recordPaymentOutcomeEvent } from '../merchant-webhooks/merchant-events.js';
import { PaymentStateConflictError } from './payment-errors.js';
import { PaymentEventType, recordPaymentEvent } from './payment-events.js';
import {
  attemptStatusesThatCanBecome,
  canTransitionPayment,
  type AttemptResolution,
} from './payment-lifecycle.js';

// Which evidence decided an outcome, kept in the payment's history.
export interface ResolutionProvenance {
  source: PaymentEventSource;
  outboxJobId?: string;
  webhookEventId?: string;
}

// Applies a definite outcome to an attempt and its payment within the caller's transaction, and
// records it in the payment's history and as a merchant event in the same transaction. Returns
// false when the attempt already has an outcome, so a late, duplicate or racing result never
// overwrites a terminal state.
export async function applyAttemptResolution(
  tx: Prisma.TransactionClient,
  attemptId: string,
  resolution: AttemptResolution,
  provenance: ResolutionProvenance,
): Promise<boolean> {
  const attemptSources = attemptStatusesThatCanBecome(resolution.attemptStatus);
  const [attempt] = await tx.paymentAttempt.updateManyAndReturn({
    where: { id: attemptId, status: { in: attemptSources } },
    data: {
      status: resolution.attemptStatus,
      providerReference: resolution.providerReference,
      failureCode: resolution.failureCode,
      completedAt: new Date(),
    },
    select: { paymentId: true },
  });
  if (!attempt) return false;

  // An attempt only ever resolves a PENDING payment; AUTHORIZED -> SUCCEEDED belongs to captures.
  if (!canTransitionPayment(PaymentStatus.PENDING, resolution.paymentStatus)) {
    throw new PaymentStateConflictError(attempt.paymentId);
  }
  const payment = await tx.payment.updateMany({
    where: { id: attempt.paymentId, status: PaymentStatus.PENDING },
    data: { status: resolution.paymentStatus },
  });
  if (payment.count !== 1)
    throw new PaymentStateConflictError(attempt.paymentId);

  await recordPaymentEvent(tx, {
    paymentId: attempt.paymentId,
    attemptId,
    type: PaymentEventType.ATTEMPT_RESOLVED,
    source: provenance.source,
    // The guarded attempt update admits exactly one source status (PENDING).
    attemptStatusBefore: onlySource(attemptSources),
    attemptStatusAfter: resolution.attemptStatus,
    paymentStatusBefore: PaymentStatus.PENDING,
    paymentStatusAfter: resolution.paymentStatus,
    outboxJobId: provenance.outboxJobId,
    webhookEventId: provenance.webhookEventId,
    details: {
      providerReference: resolution.providerReference,
      failureCode: resolution.failureCode,
    },
  });
  await recordPaymentOutcomeEvent(tx, attempt.paymentId, attemptId);
  return true;
}

export interface RecordedOutcome {
  status: PaymentAttemptStatus;
  failureCode: PaymentFailureCode | null;
  providerReference: string | null;
}

// Whether a provider answer agrees with the outcome already recorded for the attempt. A recorded
// outcome without a provider reference (the provider refused the attempt) matches on status alone.
export function matchesRecordedOutcome(
  recorded: RecordedOutcome,
  resolution: AttemptResolution,
): boolean {
  return (
    recorded.status === resolution.attemptStatus &&
    recorded.failureCode === resolution.failureCode &&
    (recorded.providerReference === null ||
      recorded.providerReference === resolution.providerReference)
  );
}

function onlySource<T>(sources: T[]): T | null {
  return sources.length === 1 ? sources[0] : null;
}
