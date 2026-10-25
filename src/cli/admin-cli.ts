import { parseArgs } from 'node:util';
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

const DEAD_JOBS_SHOWN = 20;

export interface AdminCliDependencies {
  merchants: MerchantsService;
  apiKeys: ApiKeysService;
  outbox: OutboxStore;
}

export interface AdminCliOutput {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const ADMIN_USAGE = `Usage: payguard-admin <command> [options]

Commands:
  merchant:create     --name <name> [--slug <slug>] [--key-label <label>] [--key-expires-at <ISO date>]
  merchant:list
  merchant:suspend    --merchant <id|slug>
  merchant:reactivate --merchant <id|slug>
  key:create          --merchant <id|slug> [--label <label>] [--expires-at <ISO date>]
  key:list            --merchant <id|slug>
  key:revoke          --key <id|prefix>
  ops:status
  outbox:requeue      --job <id>`;

class UsageError extends Error {}

const OPTIONS = {
  name: { type: 'string' },
  slug: { type: 'string' },
  merchant: { type: 'string' },
  key: { type: 'string' },
  job: { type: 'string' },
  label: { type: 'string' },
  'key-label': { type: 'string' },
  'expires-at': { type: 'string' },
  'key-expires-at': { type: 'string' },
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
      error instanceof ApiKeyNotFoundError
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
  { merchants, apiKeys, outbox }: AdminCliDependencies,
  io: AdminCliOutput,
): Promise<void> {
  switch (command) {
    case 'merchant:create': {
      const { merchant, apiKey } = await merchants.provision({
        name: required(options, 'name'),
        slug: options.slug,
        firstKey: {
          label: options['key-label'],
          expiresAt: optionalDate(options['key-expires-at']),
        },
      });
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
      const key = await apiKeys.revoke(required(options, 'key'));
      io.out(
        `API key ${key.prefix} revoked at ${key.revokedAt?.toISOString()}`,
      );
      return;
    }
    case 'ops:status': {
      printOutboxStats(await outbox.stats(), io);
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
    case 'outbox:requeue': {
      const jobId = required(options, 'job');
      if (!(await outbox.requeueDead(jobId))) {
        throw new UsageError(`No DEAD outbox job with id ${jobId}`);
      }
      io.out(`Outbox job ${jobId} requeued`);
      return;
    }
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

function printOutboxStats(stats: OutboxStats, io: AdminCliOutput): void {
  io.out('Outbox jobs:');
  for (const row of stats.jobs) {
    io.out(`  ${row.type.padEnd(18)} ${row.status.padEnd(11)} ${row.count}`);
  }
  io.out(`Dead jobs:                      ${stats.deadJobs}`);
  io.out(`Expired leases:                 ${stats.expiredLeases}`);
  io.out(
    `Oldest due job age (s):         ${stats.oldestDueJobAgeSeconds ?? '-'}`,
  );
  io.out(`Reconciliation lookup runs:     ${stats.reconciliationLookups}`);
  io.out(`Unresolved attempts:            ${stats.unresolvedAttempts}`);
  io.out(
    `Oldest unresolved attempt (s):  ${stats.oldestUnresolvedAttemptAgeSeconds ?? '-'}`,
  );
  if (stats.pendingErrors.length > 0) {
    io.out('Last error of unfinished jobs:');
    for (const row of stats.pendingErrors) {
      io.out(`  ${row.lastError.padEnd(22)} ${row.count}`);
    }
  }
}

function required(
  options: Options,
  name: 'name' | 'merchant' | 'key' | 'job',
): string {
  const value = options[name];
  if (!value) throw new UsageError(`Missing required option --${name}`);
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
  ].filter(Boolean);
  io.out(`  key ${key.id}  ${key.prefix}  ${details.join('  ')}`);
}
