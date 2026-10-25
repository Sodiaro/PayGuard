import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module.js';
import { MerchantsModule } from '../merchants/merchants.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';

@Module({
  imports: [AppConfigModule, MerchantsModule, OutboxModule],
})
export class AdminModule {}
