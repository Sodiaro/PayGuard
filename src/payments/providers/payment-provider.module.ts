import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoreEnvironment } from '../../config/environment.js';
import { PAYMENT_PROVIDER } from './payment-provider.js';
import { SimulatedPaymentProvider } from './simulated-payment-provider.js';

@Module({
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<CoreEnvironment, true>) => {
        const outcome = config.get('PAYMENT_SIMULATOR_OUTCOME', {
          infer: true,
        });
        const ambiguous = config.get(
          'PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS',
          { infer: true },
        );
        new Logger('PaymentProviderModule').warn(
          `Payments use the simulated provider (outcome: ${outcome}, ambiguous submissions: ${ambiguous}); no real money is moved`,
        );
        return new SimulatedPaymentProvider(outcome, ambiguous);
      },
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentProviderModule {}
