import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CoreConfigModule } from '../config/app-config.module.js';
import { MerchantsModule } from '../merchants/merchants.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PaymentInvestigator } from '../payments/payment-investigation.js';
import { SimulatedWebhookSender } from './simulated-webhook-sender.js';

@Module({
  imports: [
    CoreConfigModule,
    DatabaseModule,
    MerchantsModule,
    OutboxModule,
    AuditModule,
  ],
  providers: [SimulatedWebhookSender, PaymentInvestigator],
})
export class AdminModule {}
