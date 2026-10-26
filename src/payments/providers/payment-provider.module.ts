import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NodeEnvironment,
  type ProcessingEnvironment,
} from '../../config/environment.js';
import {
  PAYMENT_PROVIDER,
  PaymentProviderName,
  type PaymentProvider,
} from './payment-provider.js';
import { SimulatedPaymentProvider } from './simulated-payment-provider.js';

export function createPaymentProvider(
  config: ConfigService<ProcessingEnvironment, true>,
): PaymentProvider {
  const provider = config.get('PAYMENT_PROVIDER', { infer: true });
  const environment = config.get('NODE_ENV', { infer: true });

  switch (provider) {
    case PaymentProviderName.Simulator: {
      // Configuration validation already refuses this; repeated so the provider can never be
      // built for production by a path that skipped it.
      if (environment === NodeEnvironment.Production) {
        throw new Error(
          'The payment simulator cannot run with NODE_ENV=production',
        );
      }
      const outcome = config.get('PAYMENT_SIMULATOR_OUTCOME', { infer: true });
      const ambiguous = config.get('PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS', {
        infer: true,
      });
      new Logger('PaymentProviderModule').warn(
        `Payments use the simulated provider (outcome: ${outcome}, ambiguous submissions: ${ambiguous}); no real money is moved`,
      );
      return new SimulatedPaymentProvider(outcome, ambiguous);
    }
    default:
      throw new Error('PAYMENT_PROVIDER does not name a supported provider');
  }
}

@Module({
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: createPaymentProvider,
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentProviderModule {}
