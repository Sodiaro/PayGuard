import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module.js';
import type { EnvironmentVariables } from '../config/environment.js';
import { DatabaseModule } from '../database/database.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PAYMENT_PROVIDER } from './providers/payment-provider.js';
import { SimulatedPaymentProvider } from './providers/simulated-payment-provider.js';

@Module({
  imports: [DatabaseModule, RateLimitModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
        const outcome = config.get('PAYMENT_SIMULATOR_OUTCOME', {
          infer: true,
        });
        new Logger('PaymentsModule').warn(
          `Payments use the simulated provider (outcome: ${outcome}); no real money is moved`,
        );
        return new SimulatedPaymentProvider(outcome);
      },
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
