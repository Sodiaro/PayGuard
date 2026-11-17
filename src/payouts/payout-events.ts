import { requestContext } from '../common/logging/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  PaymentEventSource,
  PayoutStatus,
} from '../generated/prisma/enums.js';
import { PaymentEventType } from '../payments/payment-events.js';

// Payout history types. The job and reconciliation types are shared with payment history, so one
// query finds, say, every dead job.
export const PayoutEventType = {
  PAYOUT_CREATED: 'payout.created',
  PAYOUT_SUBMITTED: 'payout.submitted',
  PAYOUT_OUTCOME_UNKNOWN: 'payout.outcome_unknown',
  PAYOUT_RESOLVED: 'payout.resolved',
  // A definite provider answer that disagrees with the outcome already recorded.
  PAYOUT_RESULT_CONFLICT: 'payout.result_conflict',
  RECONCILIATION_DEFERRED: PaymentEventType.RECONCILIATION_DEFERRED,
  RECONCILIATION_SCHEDULED: PaymentEventType.RECONCILIATION_SCHEDULED,
  JOB_DEAD: PaymentEventType.JOB_DEAD,
  JOB_REQUEUED: PaymentEventType.JOB_REQUEUED,
} as const;

export type PayoutEventType =
  (typeof PayoutEventType)[keyof typeof PayoutEventType];

export interface PayoutEventInput {
  payoutId: string;
  type: PayoutEventType;
  source: PaymentEventSource;
  statusBefore?: PayoutStatus | null;
  statusAfter?: PayoutStatus | null;
  actor?: string | null;
  outboxJobId?: string | null;
  // Identifiers, statuses, codes and counts only: never amounts, account details or payloads.
  details?: Prisma.InputJsonObject;
}

// Always called with the transaction that makes the change it describes.
export async function recordPayoutEvent(
  db: Prisma.TransactionClient,
  event: PayoutEventInput,
): Promise<void> {
  await db.payoutEvent.create({ data: toRow(event) });
}

export async function recordPayoutEvents(
  db: Prisma.TransactionClient,
  events: PayoutEventInput[],
): Promise<void> {
  if (events.length > 0) {
    await db.payoutEvent.createMany({ data: events.map(toRow) });
  }
}

function toRow(event: PayoutEventInput): Prisma.PayoutEventCreateManyInput {
  return {
    payoutId: event.payoutId,
    type: event.type,
    source: event.source,
    statusBefore: event.statusBefore ?? null,
    statusAfter: event.statusAfter ?? null,
    actor: event.actor ?? null,
    requestId: requestContext.getStore()?.requestId ?? null,
    outboxJobId: event.outboxJobId ?? null,
    details: event.details ?? {},
  };
}
