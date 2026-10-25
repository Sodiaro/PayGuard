import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { RateLimitModule } from './common/rate-limit/rate-limit.module.js';
import { AppConfigModule } from './config/app-config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { MerchantsModule } from './merchants/merchants.module.js';
import { PaymentProcessingModule } from './payments/processing/payment-processing.module.js';
import { PaymentsModule } from './payments/payments.module.js';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    // Before AuthModule: global guards run in registration order, and the per-IP limit must
    // reject floods before the API-key guard spends a database lookup on them.
    RateLimitModule,
    AuthModule,
    HealthModule,
    MerchantsModule,
    PaymentsModule,
    PaymentProcessingModule,
  ],
})
export class AppModule {}
