import { Module } from '@nestjs/common';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { RefundsController } from './refunds.controller.js';
import { RefundsService } from './refunds.service.js';

@Module({
  imports: [DatabaseModule, OutboxModule, RateLimitModule],
  controllers: [RefundsController],
  providers: [RefundsService],
})
export class RefundsModule {}
