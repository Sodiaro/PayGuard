import { Module } from '@nestjs/common';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PaymentActionsController } from './payment-actions.controller.js';
import { PaymentActionsService } from './payment-actions.service.js';

// Capture and void of manual-capture payments. The worker runs PaymentActionJobProcessor.
@Module({
  imports: [DatabaseModule, OutboxModule, RateLimitModule],
  controllers: [PaymentActionsController],
  providers: [PaymentActionsService],
})
export class CapturesModule {}
