import { NestFactory } from '@nestjs/core';
import { AppLogger } from '../common/logging/app-logger.js';
import { ApiKeysService } from '../merchants/api-keys.service.js';
import { MerchantsService } from '../merchants/merchants.service.js';
import { AdminModule } from './admin.module.js';
import { runAdminCli } from './admin-cli.js';

// Operator-only entry point: runs with direct database access, so it is not exposed over HTTP.
const app = await NestFactory.createApplicationContext(AdminModule, {
  logger: new AppLogger({ json: false, logLevels: ['error', 'warn'] }),
});

try {
  process.exitCode = await runAdminCli(
    process.argv.slice(2),
    { merchants: app.get(MerchantsService), apiKeys: app.get(ApiKeysService) },
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
  );
} finally {
  await app.close();
}
