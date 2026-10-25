import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CoreConfigModule } from '../config/app-config.module.js';
import { MerchantsModule } from '../merchants/merchants.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';

@Module({
  imports: [CoreConfigModule, MerchantsModule, OutboxModule, AuditModule],
})
export class AdminModule {}
