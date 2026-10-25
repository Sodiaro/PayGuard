import type { INestApplication } from '@nestjs/common';
import { OperatorAuditLog } from '../../src/audit/operator-audit-log.js';
import { runAdminCli } from '../../src/cli/admin-cli.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ApiKeysService } from '../../src/merchants/api-keys.service.js';
import { MerchantsService } from '../../src/merchants/merchants.service.js';
import { OutboxStore } from '../../src/outbox/outbox-store.js';

export const TEST_OPERATOR = 'test-operator@ci';

export async function runCli(app: INestApplication, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdminCli(
    argv,
    {
      merchants: app.get(MerchantsService),
      apiKeys: app.get(ApiKeysService),
      outbox: app.get(OutboxStore),
      audit: new OperatorAuditLog(app.get(PrismaService)),
      actor: TEST_OPERATOR,
    },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}
