import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { OutboxModule } from '../../outbox/outbox.module.js';
import { PaymentsModule } from '../payments.module.js';
import { AttemptJobProcessor } from './attempt-job-processor.js';
import { OutboxWorker } from './outbox-worker.js';

// Imported by the HTTP application only; the operator CLI must never start a worker.
@Module({
  imports: [DatabaseModule, OutboxModule, PaymentsModule],
  providers: [AttemptJobProcessor, OutboxWorker],
  exports: [OutboxWorker],
})
export class PaymentProcessingModule {}
