import { Module } from '@nestjs/common';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MerchantEventsService } from './merchant-events.service.js';
import { MerchantWebhooksController } from './merchant-webhooks.controller.js';
import { WebhookEndpointService } from './webhook-endpoint.service.js';

// The merchant-facing API. Deliveries run in the worker (MerchantEventDeliveryProcessor).
@Module({
  imports: [DatabaseModule, RateLimitModule],
  controllers: [MerchantWebhooksController],
  providers: [WebhookEndpointService, MerchantEventsService],
})
export class MerchantWebhooksModule {}
