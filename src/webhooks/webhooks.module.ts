import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { ProviderWebhookInbox } from './provider-webhook-inbox.js';
import { ProviderWebhooksController } from './provider-webhooks.controller.js';

// HTTP intake only. Applying stored events is outbox work, done by ProviderWebhookProcessor in
// PaymentProcessingModule wherever the worker runs.
@Module({
  imports: [DatabaseModule, OutboxModule],
  controllers: [ProviderWebhooksController],
  providers: [ProviderWebhookInbox],
})
export class WebhooksModule {}
