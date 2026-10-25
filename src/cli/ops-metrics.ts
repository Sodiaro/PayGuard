import type { OutboxStats, OutboxStore } from '../outbox/outbox-store.js';

type WorkerSnapshot = Awaited<ReturnType<OutboxStore['workerSnapshot']>>;

interface Sample {
  labels?: Record<string, string>;
  value: number;
}

// Prometheus text exposition of database-derived gauges, for a textfile collector or a scraper
// wrapper. Label values are enum members only, never identifiers or free text, so cardinality is
// fixed. Values describe retained rows: counts can drop after maintenance:prune.
export function renderPrometheusMetrics(
  stats: OutboxStats,
  workers: WorkerSnapshot,
): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, samples: Sample[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const sample of samples) {
      const labels = sample.labels
        ? `{${Object.entries(sample.labels)
            .map(([key, value]) => `${key}="${value}"`)
            .join(',')}}`
        : '';
      lines.push(`${name}${labels} ${sample.value}`);
    }
  };
  const single = (value: number | null) => [{ value: value ?? 0 }];

  gauge(
    'payguard_outbox_jobs',
    'Retained outbox jobs by type and status.',
    stats.jobs.map((row) => ({
      labels: { type: row.type, status: row.status },
      value: row.count,
    })),
  );
  gauge(
    'payguard_outbox_dead_jobs',
    'Jobs that exhausted their runs.',
    single(stats.deadJobs),
  );
  gauge(
    'payguard_outbox_expired_leases',
    'Jobs still PROCESSING after their lease expired.',
    single(stats.expiredLeases),
  );
  gauge(
    'payguard_outbox_oldest_due_job_age_seconds',
    'Age of the oldest queued job that is due (0 when none).',
    single(stats.oldestDueJobAgeSeconds),
  );
  gauge(
    'payguard_outbox_lease_recoveries',
    'Claims that took over a job from a worker whose lease expired.',
    single(stats.leaseRecoveries),
  );
  gauge(
    'payguard_outbox_unfinished_jobs_by_last_error',
    'Unfinished jobs by the sanitized category of their last delay.',
    stats.pendingErrors.map((row) => ({
      labels: { category: row.lastError },
      value: row.count,
    })),
  );
  gauge(
    'payguard_reconciliation_lookup_runs',
    'Lookup runs recorded on retained reconciliation jobs.',
    single(stats.reconciliationLookups),
  );
  gauge(
    'payguard_payment_attempts',
    'Payment attempts by status and failure code.',
    stats.attempts.map((row) => ({
      labels: { status: row.status, failure_code: row.failureCode ?? 'none' },
      value: row.count,
    })),
  );
  gauge(
    'payguard_payment_attempts_unresolved',
    'Attempts without a final outcome.',
    single(stats.unresolvedAttempts),
  );
  gauge(
    'payguard_payment_attempts_oldest_unresolved_age_seconds',
    'Age of the oldest attempt without a final outcome (0 when none).',
    single(stats.oldestUnresolvedAttemptAgeSeconds),
  );
  gauge(
    'payguard_payment_retries',
    'Accepted payment retries.',
    single(stats.paymentRetries),
  );
  gauge(
    'payguard_payment_attempt_settle_seconds',
    'Attempt creation to final outcome, over attempts completed in the last hour.',
    [
      { labels: { quantile: '0.5' }, value: stats.settleSecondsP50 ?? 0 },
      { labels: { quantile: '0.95' }, value: stats.settleSecondsP95 ?? 0 },
    ],
  );
  gauge(
    'payguard_webhook_events',
    'Retained provider webhook events by status and processing result.',
    stats.webhookEvents.map((row) => ({
      labels: { status: row.status, result: row.result ?? 'none' },
      value: row.count,
    })),
  );
  gauge(
    'payguard_webhook_duplicate_deliveries',
    'Repeated deliveries of stored webhook events, ignored as duplicates.',
    single(stats.webhookDuplicateDeliveries),
  );
  gauge(
    'payguard_webhook_conflicting_deliveries',
    'Deliveries that reused a stored event ID with different content, rejected.',
    single(stats.webhookConflictingDeliveries),
  );
  gauge(
    'payguard_workers_active',
    'Workers with a recent heartbeat.',
    single(workers.activeWorkers),
  );
  gauge(
    'payguard_worker_last_heartbeat_age_seconds',
    'Age of the most recent worker heartbeat (-1 when no worker ever ran).',
    [{ value: workers.lastHeartbeatAgeSeconds ?? -1 }],
  );
  gauge(
    'payguard_worker_last_job_finished_age_seconds',
    'Age of the most recently finished job batch across workers (-1 when none).',
    [{ value: workers.lastJobFinishedAgeSeconds ?? -1 }],
  );

  return `${lines.join('\n')}\n`;
}
