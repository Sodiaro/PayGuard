import type { INestApplication } from '@nestjs/common';
import { OperatorAuditLog } from '../../src/audit/operator-audit-log.js';
import {
  runAdminCli,
  type AdminCliDependencies,
} from '../../src/cli/admin-cli.js';
import { SimulatedWebhookSender } from '../../src/cli/simulated-webhook-sender.js';
import { ApiKeysService } from '../../src/merchants/api-keys.service.js';
import { MerchantsService } from '../../src/merchants/merchants.service.js';
import { OutboxStore } from '../../src/outbox/outbox-store.js';
import { PaymentInvestigator } from '../../src/payments/payment-investigation.js';
import { operatorOf } from './test-app.js';

export const TEST_OPERATOR = 'test-operator@ci';

// The CLI's services as admin.ts wires them, connected as the operator role.
export function cliDependencies(
  app: INestApplication,
  actor = TEST_OPERATOR,
): AdminCliDependencies {
  const operator = operatorOf(app);
  return {
    merchants: operator.get(MerchantsService),
    apiKeys: operator.get(ApiKeysService),
    outbox: operator.get(OutboxStore),
    audit: operator.get(OperatorAuditLog),
    simulator: operator.get(SimulatedWebhookSender),
    investigator: operator.get(PaymentInvestigator),
    actor,
  };
}

export async function runCli(app: INestApplication, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdminCli(argv, cliDependencies(app), {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
