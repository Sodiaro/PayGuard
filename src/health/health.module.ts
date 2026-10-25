import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { DatabaseHealthIndicator } from './database.health-indicator.js';
import { HealthController } from './health.controller.js';
import {
  QueueHealthIndicator,
  WorkerHealthIndicator,
} from './outbox.health-indicator.js';

@Module({
  imports: [TerminusModule, DatabaseModule, OutboxModule],
  controllers: [HealthController],
  providers: [
    DatabaseHealthIndicator,
    QueueHealthIndicator,
    WorkerHealthIndicator,
  ],
})
export class HealthModule {}
