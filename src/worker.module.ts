import { Module } from '@nestjs/common';
import { workerConfigModule } from './config/app-config.module.js';
import { PaymentProcessingModule } from './payments/processing/payment-processing.module.js';

// The standalone worker: outbox processing only, with no HTTP server, controllers or API-only
// configuration.
@Module({
  imports: [workerConfigModule(), PaymentProcessingModule],
})
export class WorkerModule {}
