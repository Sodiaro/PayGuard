import { parseArgs } from 'node:util';
import type { OperatorAuditLog } from '../audit/operator-audit-log.js';
import { MerchantStatus } from '../generated/prisma/enums.js';
import type {
  ApiKeysService,
  ApiKeySummary,
  IssuedApiKey,
} from '../merchants/api-keys.service.js';
import {
  ApiKeyNotFoundError,
  InvalidMerchantInputError,
  MerchantAlreadyExistsError,
  MerchantNotFoundError,
} from '../merchants/merchant-errors.js';
import type {
  MerchantProfile,
  MerchantsService,
} from '../merchants/merchants.service.js';
import type { OutboxStats, OutboxStore } from '../outbox/outbox-store.js';
import type { PaymentInvestigator } from '../payments/payment-investigation.js';
import { renderPrometheusMetrics } from './ops-metrics.js';
import { printInvestigation, printUnresolved } from './payment-reports.js';
import {
  SimulatorWebhookError,
  type SimulatedWebhookSender,
} from './simulated-webhook-sender.js';

const DEAD_JOBS_SHOWN = 20;
const WORKERS_SHOWN = 20;
// Matches the default HEALTH_WORKER_TIMEOUT_SECONDS used by /health.
const WORKER_ACTIVE_SECONDS = 30;
// Below this, a typo in a prune command could remove history that support still needs.
const MIN_RETENTION_DAYS = 7;
const DEFAULT_SIMULATOR_TARGET = 'http://127.0.0.1:3000';
const UUID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AdminCliDependencies {
  merchants: MerchantsService;
  apiKeys: ApiKeysService;
  outbox: OutboxStore;
  audit: OperatorAuditLog;
  simulator: SimulatedWebhookSender;
  investigator: PaymentInvestigator;
  // Recorded on every state-changing command (see resolveOperator).
  actor: string;
}

export interface AdminCliOutput {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const ADMIN_USAGE = `Usage: payguard-admin <command> [options]

Merchants and keys:
  merchant:create     --name <name> [--slug <slug>] [--key-label <label>] [--key-expires-at <ISO date>]
  merchant:list
  merchant:suspend    --merchant <id|slug>
  merchant:reactivate --merchant <id|slug>
  key:create          --merchant <id|slug> [--label <label>] [--expires-at <ISO date>]
  key:list            --merchant <id|slug>
  key:revoke          --key <id|prefix>

Operations:
  ops:status
  ops:metrics
  outbox:requeue      --job <id>
  payments:unresolved [--merchant <id|slug>] [--limit <1-200>]
  payment:inspect     --payment <id>
  audit:list          [--limit <1-200>]
  maintenance:prune   --completed-jobs-days <n> [--workers-days <n>] [--batch-size <n>]   (n >= ${MIN_RETENTION_DAYS})

Simulator (refused when NODE_ENV=production):
  simulator:webhook   --attempt <id> [--type payment.succeeded|payment.declined|payment.processing] [--url <API base URL>]`;

class UsageError extends Error {}
// A well-formed command that cannot be carried out; reported without the usage text.
class CommandError extends Error {}

const OPTIONS = {
  name: { type: 'string' },
  slug: { type: 'string' },
  merchant: { type: 'string' },
  key: { type: 'string' },
  job: { type: 'string' },
  label: { type: 'string' },
  limit: { type: 'string' },
  'key-label': { type: 'string' },
  'expires-at': { type: 'string' },
  'key-expires-at': { type: 'string' },
  'completed-jobs-days': { type: 'string' },
  'workers-days': { type: 'string' },
  'batch-size': { type: 'string' },
  attempt: { type: 'string' },
  payment: { type: 'string' },
  type: { type: 'string' },
  url: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Options = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS }>
>['values'];

export async function runAdminCli(
  argv: string[],
  deps: AdminCliDependencies,
  io: AdminCliOutput,
): Promise<number> {
  let command: string | undefined;
  let options: Options;
  try {
    const parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
    [command] = parsed.positionals;
    options = parsed.values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(ADMIN_USAGE);
    return 1;
  }

  if (!command || options.help) {
    io.out(ADMIN_USAGE);
    return command || options.help ? 0 : 1;
  }

  try {
    await execute(command, options, deps, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err(ADMIN_USAGE);
      return 1;
    }
    if (
      error instanceof InvalidMerchantInputError ||
      error instanceof MerchantAlreadyExistsError ||
      error instanceof MerchantNotFoundError ||
      error instanceof ApiKeyNotFoundError ||
      error instanceof SimulatorWebhookError ||
      error instanceof CommandError
    ) {
      io.err(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function execute(
  command: string,
  options: Options,
  {
    merchants,
    apiKeys,
    outbox,
    audit,
    simulator,
    investigator,
    actor,
  }: AdminCliDependencies,
  io: AdminCliOutput,
): Promise<void> {
  switch (command) {
    case 'merchant:create': {
      const { merchant, apiKey } = await merchants.provision(
        {
          name: required(options, 'name'),
          slug: options.slug,
          firstKey: {
            label: options['key-label'],
            expiresAt: optionalDate(options['key-expires-at']),
          },
        },
        actor,
      );
      io.out('Merchant created');
      printMerchant(merchant, io);
      printIssuedKey(apiKey, io);
      return;
    }
    case 'merchant:list': {
      for (const merchant of await merchants.list()) {
        io.out(
          `${merchant.id}  ${merchant.status.padEnd(9)}  ${merchant.slug}  (${merchant.name})`,
        );
      }
      return;
    }
    case 'merchant:suspend':
    case 'merchant:reactivate': {
      const status =
        command === 'merchant:suspend'
          ? MerchantStatus.SUSPENDED
          : MerchantStatus.ACTIVE;
      const merchant = await merchants.setStatus(
        required(options, 'merchant'),
        status,
        actor,
      );
      io.out(`Merchant ${merchant.slug} is now ${merchant.status}`);
      return;
    }
    case 'key:create': {
      const { merchant, apiKey } = await merchants.issueKey(
        required(options, 'merchant'),
        {
          label: options.label,
          expiresAt: optionalDate(options['expires-at']),
        },
        actor,
      );
      io.out(`API key issued for ${merchant.slug}`);
      printIssuedKey(apiKey, io);
      return;
    }
    case 'key:list': {
      const merchant = await merchants.resolve(required(options, 'merchant'));
      for (const key of await apiKeys.listForMerchant(merchant.id)) {
        printKeySummary(key, io);
      }
      return;
    }
    case 'key:revoke': {
      const key = await apiKeys.revoke(required(options, 'key'), actor);
      io.out(
        `API key ${key.prefix} revoked at ${key.revokedAt?.toISOString()}`,
      );
      return;
    }
    case 'ops:status': {
      printOutboxStats(await outbox.stats(), io);
      await printWorkers(outbox, io);
      const dead = await outbox.listDead(DEAD_JOBS_SHOWN);
      if (dead.length > 0) {
        io.out('');
        io.out(
          'Dead jobs (oldest first; requeue with outbox:requeue --job <id>):',
        );
        for (const job of dead) {
          io.out(
            `  ${job.id}  ${job.type}  payment=${job.paymentId}  attempt=${job.attemptId}  runs=${job.runCount}  lastError=${job.lastError ?? '-'}`,
          );
        }
      }
      return;
    }
    case 'ops:metrics': {
      const [stats, workers] = await Promise.all([
        outbox.stats(),
        outbox.workerSnapshot(WORKER_ACTIVE_SECONDS),
      ]);
      io.out(renderPrometheusMetrics(stats, workers).trimEnd());
      return;
    }
    case 'payments:unresolved': {
      const merchant = options.merchant
        ? await merchants.resolve(options.merchant)
        : undefined;
      printUnresolved(
        await investigator.unresolved({
          limit: integerOption(options, 'limit', 50, 1, 200),
          merchantId: merchant?.id,
        }),
        io,
      );
      return;
    }
    case 'payment:inspect': {
      const paymentId = required(options, 'payment');
      if (!UUID_FORMAT.test(paymentId)) {
        throw new UsageError('--payment must be a payment ID');
      }
      const payment = await investigator.inspect(paymentId);
      if (!payment) throw new CommandError(`No payment with id ${paymentId}`);
      printInvestigation(payment, io);
      return;
    }
    case 'outbox:requeue': {
      const jobId = required(options, 'job');
      if (!(await outbox.requeueDead(jobId, actor))) {
        throw new UsageError(`No DEAD outbox job with id ${jobId}`);
      }
      io.out(`Outbox job ${jobId} requeued`);
      return;
    }
    case 'audit:list': {
      const limit = integerOption(options, 'limit', 20, 1, 200);
      for (const event of await audit.recent(limit)) {
        io.out(
          `${event.createdAt.toISOString()}  ${event.actor}  ${event.action}  ${event.targetType}=${event.targetId}  ${JSON.stringify(event.details)}`,
        );
      }
      return;
    }
    case 'maintenance:prune': {
      const jobDays = integerOption(
        options,
        'completed-jobs-days',
        undefined,
        MIN_RETENTION_DAYS,
        36_500,
      );
      const workerDays = integerOption(
        options,
        'workers-days',
        jobDays,
        MIN_RETENTION_DAYS,
        36_500,
      );
      const batchSize = integerOption(options, 'batch-size', 1000, 1, 10_000);

      const deletedJobs = await outbox.pruneCompletedJobs(jobDays, batchSize);
      const deletedWorkers = await outbox.pruneWorkers(workerDays);
      await audit.record({
        actor,
        action: 'maintenance.pruned',
        targetType: 'outbox',
        targetId: 'outbox_jobs',
        details: {
          completedJobsOlderThanDays: jobDays,
          workersOlderThanDays: workerDays,
          deletedJobs,
          deletedWorkers,
        },
      });
      io.out(
        `Deleted ${deletedJobs} completed outbox jobs older than ${jobDays} days and ${deletedWorkers} worker records older than ${workerDays} days`,
      );
      return;
    }
    case 'simulator:webhook': {
      const delivery = await simulator.send({
        attemptId: required(options, 'attempt'),
        type: options.type,
        baseUrl: options.url ?? DEFAULT_SIMULATOR_TARGET,
      });
      const line = `Delivered ${delivery.eventId} (${delivery.type}): HTTP ${delivery.statusCode} ${delivery.receipt}`;
      if (delivery.statusCode >= 300) throw new SimulatorWebhookError(line);
      io.out(line);
      return;
    }
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

function printOutboxStats(stats: OutboxStats, io: AdminCliOutput): void {
  io.out('Outbox jobs:');
  for (const row of stats.jobs) {
    io.out(`  ${row.type.padEnd(20)} ${row.status.padEnd(11)} ${row.count}`);
  }
  io.out(`Dead jobs:                      ${stats.deadJobs}`);
  io.out(`Expired leases:                 ${stats.expiredLeases}`);
  io.out(`Lease recoveries:               ${stats.leaseRecoveries}`);
  io.out(
    `Oldest due job age (s):         ${stats.oldestDueJobAgeSeconds ?? '-'}`,
  );
  io.out(`Reconciliation lookup runs:     ${stats.reconciliationLookups}`);
  io.out(`Unresolved attempts:            ${stats.unresolvedAttempts}`);
  io.out(
    `Oldest unresolved attempt (s):  ${stats.oldestUnresolvedAttemptAgeSeconds ?? '-'}`,
  );
  io.out(
    `Awaiting an operator:           ${stats.attemptsAwaitingOperator} (lookups exhausted; see payments:unresolved)`,
  );
  io.out(`Contradicting provider answers: ${stats.attemptResultConflicts}`);
  io.out(`Payment retries:                ${stats.paymentRetries}`);
  io.out(
    `Settle time p50/p95, 1h (s):    ${formatSeconds(stats.settleSecondsP50)} / ${formatSeconds(stats.settleSecondsP95)}`,
  );
  if (stats.pendingErrors.length > 0) {
    io.out('Last error of unfinished jobs:');
    for (const row of stats.pendingErrors) {
      io.out(`  ${row.lastError.padEnd(22)} ${row.count}`);
    }
  }
  io.out('Provider webhook events:');
  if (stats.webhookEvents.length === 0) io.out('  none received');
  for (const row of stats.webhookEvents) {
    io.out(
      `  ${row.status.padEnd(10)} ${(row.result ?? '-').padEnd(17)} ${row.count}`,
    );
  }
  io.out(`Duplicate webhook deliveries:   ${stats.webhookDuplicateDeliveries}`);
  io.out(
    `Conflicting webhook deliveries: ${stats.webhookConflictingDeliveries}`,
  );
}

async function printWorkers(
  outbox: OutboxStore,
  io: AdminCliOutput,
): Promise<void> {
  const workers = await outbox.listWorkers(WORKERS_SHOWN);
  io.out('');
  io.out(
    `Workers (active = heartbeat within ${WORKER_ACTIVE_SECONDS}s, newest first):`,
  );
  if (workers.length === 0) io.out('  none recorded');
  for (const worker of workers) {
    const heartbeatAge = secondsSince(worker.heartbeatAt);
    const state = worker.stoppedAt
      ? 'stopped'
      : heartbeatAge <= WORKER_ACTIVE_SECONDS
        ? 'active'
        : 'silent';
    const lastJob = worker.lastJobFinishedAt
      ? `${secondsSince(worker.lastJobFinishedAt)}s ago`
      : 'never';
    io.out(
      `  ${worker.id}  ${state.padEnd(7)}  heartbeat ${heartbeatAge}s ago  last job ${lastJob}  jobs=${worker.jobsFinished}`,
    );
  }
}

function secondsSince(date: Date): number {
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
}

function formatSeconds(value: number | null): string {
  return value === null ? '-' : value.toFixed(2);
}

function required(
  options: Options,
  name: 'name' | 'merchant' | 'key' | 'job' | 'attempt' | 'payment',
): string {
  const value = options[name];
  if (!value) throw new UsageError(`Missing required option --${name}`);
  return value;
}

function integerOption(
  options: Options,
  name: 'limit' | 'completed-jobs-days' | 'workers-days' | 'batch-size',
  fallback: number | undefined,
  min: number,
  max: number,
): number {
  const raw = options[name];
  if (raw === undefined) {
    if (fallback === undefined) {
      throw new UsageError(`Missing required option --${name}`);
    }
    return fallback;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    throw new UsageError(`--${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function optionalDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function printMerchant(merchant: MerchantProfile, io: AdminCliOutput): void {
  io.out(`  id:     ${merchant.id}`);
  io.out(`  slug:   ${merchant.slug}`);
  io.out(`  name:   ${merchant.name}`);
  io.out(`  status: ${merchant.status}`);
}

function printIssuedKey(key: IssuedApiKey, io: AdminCliOutput): void {
  io.out('');
  io.out(
    'API key (shown once; it cannot be retrieved again, store it securely now):',
  );
  io.out(`  ${key.plaintext}`);
  io.out('');
  printKeySummary(key, io);
}

function printKeySummary(key: ApiKeySummary, io: AdminCliOutput): void {
  const details = [
    `status=${key.status}`,
    key.label && `label=${key.label}`,
    key.expiresAt && `expires=${key.expiresAt.toISOString()}`,
    `lastUsed=${key.lastUsedAt?.toISOString() ?? 'never'}`,
  ].filter(Boolean);
  io.out(`  key ${key.id}  ${key.prefix}  ${details.join('  ')}`);
}
