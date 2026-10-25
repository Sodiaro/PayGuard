import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { OperatorAuditLog } from '../audit/operator-audit-log.js';
import { resolveOperator } from '../audit/operator-audit.js';
import { AppLogger } from '../common/logging/app-logger.js';
import type { CoreEnvironment } from '../config/environment.js';
import { ApiKeysService } from '../merchants/api-keys.service.js';
import { MerchantsService } from '../merchants/merchants.service.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { AdminModule } from './admin.module.js';
import { runAdminCli } from './admin-cli.js';

// Operator-only entry point: runs with direct database access, so it is not exposed over HTTP.
const app = await NestFactory.createApplicationContext(AdminModule, {
  logger: new AppLogger({ json: false, logLevels: ['error', 'warn'] }),
});
const config = app.get<ConfigService<CoreEnvironment, true>>(ConfigService);

try {
  process.exitCode = await runAdminCli(
    process.argv.slice(2),
    {
      merchants: app.get(MerchantsService),
      apiKeys: app.get(ApiKeysService),
      outbox: app.get(OutboxStore),
      audit: app.get(OperatorAuditLog),
      actor: resolveOperator(config.get('PAYGUARD_OPERATOR', { infer: true })),
    },
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
  );
} finally {
  await app.close();
}
