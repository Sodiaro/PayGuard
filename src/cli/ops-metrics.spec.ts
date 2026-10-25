import { describe, expect, it } from '@jest/globals';
import {
  OutboxErrorCategory,
  OutboxJobStatus,
  OutboxJobType,
  PaymentAttemptStatus,
  PaymentFailureCode,
  ProviderWebhookEventResult,
  ProviderWebhookEventStatus,
} from '../generated/prisma/enums.js';
import type { OutboxStats } from '../outbox/outbox-store.js';
import { renderPrometheusMetrics } from './ops-metrics.js';

const stats: OutboxStats = {
  jobs: [
    {
      type: OutboxJobType.PROCESS_ATTEMPT,
      status: OutboxJobStatus.COMPLETED,
      count: 12,
    },
    {
      type: OutboxJobType.RECONCILE_ATTEMPT,
      status: OutboxJobStatus.DEAD,
      count: 1,
    },
  ],
  pendingErrors: [
    { lastError: OutboxErrorCategory.OUTCOME_PROCESSING, count: 1 },
  ],
  attempts: [
    { status: PaymentAttemptStatus.SUCCEEDED, failureCode: null, count: 10 },
    {
      status: PaymentAttemptStatus.FAILED,
      failureCode: PaymentFailureCode.DECLINED,
      count: 2,
    },
  ],
  deadJobs: 1,
  expiredLeases: 0,
  oldestDueJobAgeSeconds: null,
  reconciliationLookups: 10,
  leaseRecoveries: 3,
  unresolvedAttempts: 1,
  oldestUnresolvedAttemptAgeSeconds: 840,
  paymentRetries: 2,
  settleSecondsP50: 0.42,
  settleSecondsP95: 1.9,
  webhookEvents: [
    {
      status: ProviderWebhookEventStatus.PROCESSED,
      result: ProviderWebhookEventResult.APPLIED,
      count: 7,
    },
    { status: ProviderWebhookEventStatus.RECEIVED, result: null, count: 1 },
  ],
  webhookDuplicateDeliveries: 3,
  webhookConflictingDeliveries: 1,
};

describe('renderPrometheusMetrics', () => {
  const output = renderPrometheusMetrics(stats, {
    activeWorkers: 2,
    lastHeartbeatAgeSeconds: 4,
    lastJobFinishedAgeSeconds: null,
  });

  it('renders valid exposition lines for every gauge', () => {
    const lines = output.trimEnd().split('\n');
    for (const line of lines) {
      expect(line).toMatch(
        /^(# (HELP|TYPE) payguard_[a-z_]+ .+|payguard_[a-z_]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? -?\d+(\.\d+)?)$/,
      );
    }
    expect(output).toContain(
      'payguard_outbox_jobs{type="PROCESS_ATTEMPT",status="COMPLETED"} 12',
    );
    expect(output).toContain(
      'payguard_payment_attempts{status="SUCCEEDED",failure_code="none"} 10',
    );
    expect(output).toContain(
      'payguard_payment_attempt_settle_seconds{quantile="0.95"} 1.9',
    );
    expect(output).toContain('payguard_outbox_oldest_due_job_age_seconds 0');
    expect(output).toContain(
      'payguard_worker_last_job_finished_age_seconds -1',
    );
    expect(output).toContain('payguard_workers_active 2');
    expect(output).toContain(
      'payguard_webhook_events{status="PROCESSED",result="APPLIED"} 7',
    );
    expect(output).toContain(
      'payguard_webhook_events{status="RECEIVED",result="none"} 1',
    );
    expect(output).toContain('payguard_webhook_conflicting_deliveries 1');
  });

  it('uses only bounded labels, never identifiers', () => {
    const labelNames = new Set(
      [...output.matchAll(/([a-z_]+)="/g)].map((match) => match[1]),
    );
    expect(labelNames).toEqual(
      new Set([
        'type',
        'status',
        'category',
        'failure_code',
        'quantile',
        'result',
      ]),
    );
    expect(output).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
