import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { OutboxModule } from '../../outbox/outbox.module.js';
import { ProviderWebhookProcessor } from '../../webhooks/provider-webhook-processor.js';
import { PaymentProviderModule } from '../providers/payment-provider.module.js';
import { AttemptJobProcessor } from './attempt-job-processor.js';
import { OutboxWorker } from './outbox-worker.js';

// Shared by the API (in-process worker) and the standalone worker entry point. Contains no HTTP
// components, and starting the worker is left to the host process.
@Module({
  imports: [DatabaseModule, OutboxModule, PaymentProviderModule],
  providers: [AttemptJobProcessor, ProviderWebhookProcessor, OutboxWorker],
  exports: [OutboxWorker],
})
export class PaymentProcessingModule {}
