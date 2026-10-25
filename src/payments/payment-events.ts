import { requestContext } from '../common/logging/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  PaymentAttemptStatus,
  PaymentEventSource,
  PaymentStatus,
} from '../generated/prisma/enums.js';

// Lifecycle history types. Status changes carry their before/after statuses; decisions that change
// no status (deferral, dead-lettering, distrusted or contradictory evidence) explain themselves in
// details. Operator actions are also in operator_audit_events; here they place the action in the
// payment's own timeline.
export const PaymentEventType = {
  PAYMENT_CREATED: 'payment.created',
  RETRY_ACCEPTED: 'payment.retry_accepted',
  ATTEMPT_SUBMITTED: 'attempt.submitted',
  OUTCOME_UNKNOWN: 'attempt.outcome_unknown',
  ATTEMPT_RESOLVED: 'attempt.resolved',
  // A definite provider answer that disagrees with the outcome already recorded.
  RESULT_CONFLICT: 'attempt.result_conflict',
  RECONCILIATION_DEFERRED: 'reconciliation.deferred',
  RECONCILIATION_SCHEDULED: 'reconciliation.scheduled',
  JOB_DEAD: 'outbox_job.dead',
  JOB_REQUEUED: 'outbox_job.requeued',
  WEBHOOK_NOT_APPLIED: 'webhook.not_applied',
} as const;

export type PaymentEventType =
  (typeof PaymentEventType)[keyof typeof PaymentEventType];

export interface PaymentEventInput {
  paymentId: string;
  attemptId?: string | null;
  type: PaymentEventType;
  source: PaymentEventSource;
  paymentStatusBefore?: PaymentStatus | null;
  paymentStatusAfter?: PaymentStatus | null;
  attemptStatusBefore?: PaymentAttemptStatus | null;
  attemptStatusAfter?: PaymentAttemptStatus | null;
  actor?: string | null;
  outboxJobId?: string | null;
  webhookEventId?: string | null;
  // Identifiers, statuses, codes and counts only: never amounts, credentials or provider payloads.
  details?: Prisma.InputJsonObject;
}

// Always called with the transaction that makes the change it describes, so history and state
// commit or roll back together.
export async function recordPaymentEvent(
  db: Prisma.TransactionClient,
  event: PaymentEventInput,
): Promise<void> {
  await db.paymentEvent.create({ data: toRow(event) });
}

export async function recordPaymentEvents(
  db: Prisma.TransactionClient,
  events: PaymentEventInput[],
): Promise<void> {
  if (events.length > 0) {
    await db.paymentEvent.createMany({ data: events.map(toRow) });
  }
}

function toRow(event: PaymentEventInput): Prisma.PaymentEventCreateManyInput {
  return {
    paymentId: event.paymentId,
    attemptId: event.attemptId ?? null,
    type: event.type,
    source: event.source,
    paymentStatusBefore: event.paymentStatusBefore ?? null,
    paymentStatusAfter: event.paymentStatusAfter ?? null,
    attemptStatusBefore: event.attemptStatusBefore ?? null,
    attemptStatusAfter: event.attemptStatusAfter ?? null,
    actor: event.actor ?? null,
    requestId: requestContext.getStore()?.requestId ?? null,
    outboxJobId: event.outboxJobId ?? null,
    webhookEventId: event.webhookEventId ?? null,
    details: event.details ?? {},
  };
}
