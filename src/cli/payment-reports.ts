import type {
  JobView,
  PaymentInvestigation,
  UnresolvedAttempt,
  UnresolvedDiagnosis,
} from '../payments/payment-investigation.js';
import type { AdminCliOutput } from './admin-cli.js';

export function printUnresolved(
  attempts: UnresolvedAttempt[],
  io: AdminCliOutput,
  now = new Date(),
): void {
  if (attempts.length === 0) {
    io.out('No unresolved attempts.');
    return;
  }
  const blocked = attempts.filter((attempt) => attempt.diagnosis.needsOperator);
  io.out(
    `Unresolved attempts, oldest first (${attempts.length} shown, ${blocked.length} need an operator):`,
  );
  for (const attempt of attempts) {
    io.out(
      [
        `  age=${secondsBetween(attempt.createdAt, now)}s`,
        `payment=${attempt.paymentId}`,
        `attempt=${attempt.attemptId} (#${attempt.attemptNumber}, ${attempt.merchantSlug})`,
        `submitted=${attempt.submitted ? 'yes' : 'no'}`,
        describeDiagnosis(attempt.diagnosis, now),
        `webhookConflicts=${attempt.webhookConflicts}`,
        `resultConflicts=${attempt.resultConflicts}`,
      ].join('  '),
    );
  }
  io.out('');
  io.out('Inspect one with payment:inspect --payment <id>.');
  if (blocked.length > 0) {
    io.out(
      'reconciliation_exhausted: confirm the attempt with the provider by attempt ID, then requeue its dead RECONCILE_ATTEMPT job (outbox:requeue) so the outcome is recorded from a fresh lookup.',
    );
  }
}

export function printInvestigation(
  payment: PaymentInvestigation,
  io: AdminCliOutput,
  now = new Date(),
): void {
  const attemptNumber = new Map(
    payment.attempts.map((attempt) => [attempt.id, attempt.attemptNumber]),
  );
  const label = (attemptId: string | null) =>
    attemptId ? `#${attemptNumber.get(attemptId) ?? '?'}` : '-';

  io.out(
    `Payment ${payment.id}  ${payment.status}  ${payment.amount.toString()} ${payment.currency}  reference=${payment.reference ?? '-'}`,
  );
  io.out(
    `  merchant ${payment.merchant.slug} (${payment.merchant.id}, ${payment.merchant.status})  created ${iso(payment.createdAt)}  updated ${iso(payment.updatedAt)}`,
  );

  io.out('');
  io.out('Attempts:');
  for (const attempt of payment.attempts) {
    io.out(
      `  #${attempt.attemptNumber} ${attempt.id}  ${attempt.status}  failure=${attempt.failureCode ?? '-'}  providerReference=${attempt.providerReference ?? '-'}  created ${iso(attempt.createdAt)}  submitted ${iso(attempt.submittedAt)}  completed ${iso(attempt.completedAt)}`,
    );
    for (const job of attempt.outboxJobs) {
      io.out(`      job ${job.id}  ${describeJob(job)}`);
    }
    if (attempt.diagnosis) {
      io.out(`      unresolved: ${describeDiagnosis(attempt.diagnosis, now)}`);
    }
  }

  io.out('');
  io.out('Provider webhook events:');
  if (payment.webhookEvents.length === 0) io.out('  none');
  for (const event of payment.webhookEvents) {
    io.out(
      `  ${event.eventId}  ${event.eventType}  attempt ${label(event.attemptId)}  ${event.status} ${event.result ?? '-'}  providerReference=${event.providerReference}  created ${iso(event.eventCreatedAt)}  received ${iso(event.receivedAt)}  duplicates=${event.duplicateDeliveries}  conflicting=${event.conflictingDeliveries}`,
    );
  }

  io.out('');
  io.out('History (oldest first):');
  if (payment.events.length === 0) io.out('  none recorded');
  for (const event of payment.events) {
    const parts = [
      `  ${iso(event.createdAt)}`,
      event.source.padEnd(17),
      event.type.padEnd(24),
      `attempt ${label(event.attemptId)}`,
      transition(
        'payment',
        event.paymentStatusBefore,
        event.paymentStatusAfter,
      ),
      transition(
        'attempt',
        event.attemptStatusBefore,
        event.attemptStatusAfter,
      ),
      event.actor && `actor=${event.actor} (self-declared)`,
      event.outboxJobId && `job=${event.outboxJobId}`,
      event.webhookEventId && `webhookEvent=${event.webhookEventId}`,
      event.requestId && `request=${event.requestId}`,
      Object.keys(event.details as object).length > 0 &&
        JSON.stringify(event.details),
    ];
    io.out(parts.filter(Boolean).join('  '));
  }

  io.out('');
  const pending = payment.attempts.filter((attempt) => attempt.diagnosis);
  io.out(
    pending.length === 0
      ? `Verdict: ${payment.status}; no attempt is awaiting an outcome.`
      : `Verdict: unresolved; ${pending
          .map(
            (attempt) =>
              `attempt #${attempt.attemptNumber} is ${attempt.diagnosis!.state}${attempt.diagnosis!.needsOperator ? ' and needs an operator' : ''}`,
          )
          .join('; ')}.`,
  );
}

function describeDiagnosis(diagnosis: UnresolvedDiagnosis, now: Date): string {
  return [
    `state=${diagnosis.state}`,
    `lastError=${diagnosis.lastError ?? '-'}`,
    `next=${
      diagnosis.nextRunAt
        ? `in ${Math.max(0, secondsBetween(now, diagnosis.nextRunAt))}s`
        : '-'
    }`,
    diagnosis.needsOperator && 'OPERATOR ACTION NEEDED',
  ]
    .filter(Boolean)
    .join('  ');
}

function describeJob(job: JobView & { leaseRecoveries: number }): string {
  return `${job.type} ${job.status} runs=${job.runCount} leaseRecoveries=${job.leaseRecoveries} lastError=${job.lastError ?? '-'}`;
}

function transition(
  subject: string,
  before: string | null,
  after: string | null,
): string | false {
  if (!before && !after) return false;
  return `${subject} ${before ?? '(new)'} -> ${after ?? '-'}`;
}

function iso(date: Date | null): string {
  return date ? date.toISOString() : '-';
}

function secondsBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 1000);
}
