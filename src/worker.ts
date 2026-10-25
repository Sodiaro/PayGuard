import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppLogger } from './common/logging/app-logger.js';
import { NodeEnvironment, type CoreEnvironment } from './config/environment.js';
import { OutboxWorker } from './payments/processing/outbox-worker.js';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule, {
  bufferLogs: true,
});
const config = app.get<ConfigService<CoreEnvironment, true>>(ConfigService);
app.useLogger(
  new AppLogger({
    json:
      config.get('NODE_ENV', { infer: true }) !== NodeEnvironment.Development,
  }),
);

// SIGTERM/SIGINT close the context: the worker finishes its batch in flight, then the database
// pool closes. Jobs of a process killed outright are recovered when their leases expire.
app.enableShutdownHooks();
app.get(OutboxWorker).start();
Logger.log('PayGuard worker running', 'Bootstrap');
