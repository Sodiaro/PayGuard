import { Module } from '@nestjs/common';
import { CoreConfigModule } from './config/app-config.module.js';
import { PaymentProcessingModule } from './payments/processing/payment-processing.module.js';

// The standalone worker: outbox processing only, with no HTTP server, controllers or API-only
// configuration.
@Module({
  imports: [CoreConfigModule, PaymentProcessingModule],
})
export class WorkerModule {}
