import { describe, expect, it } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { ProcessingEnvironment } from '../../config/environment.js';
import { createPaymentProvider } from './payment-provider.module.js';
import { SimulatedPaymentProvider } from './simulated-payment-provider.js';

function config(values: Record<string, unknown>) {
  return {
    get: (key: string) =>
      ({
        PAYMENT_SIMULATOR_OUTCOME: 'SUCCEEDED',
        PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: false,
        ...values,
      })[key],
  } as unknown as ConfigService<ProcessingEnvironment, true>;
}

describe('createPaymentProvider', () => {
  it('builds the simulator when it is selected outside production', () => {
    expect(
      createPaymentProvider(
        config({ PAYMENT_PROVIDER: 'simulator', NODE_ENV: 'development' }),
      ),
    ).toBeInstanceOf(SimulatedPaymentProvider);
  });

  it('never builds the simulator for production, even if validation was bypassed', () => {
    expect(() =>
      createPaymentProvider(
        config({ PAYMENT_PROVIDER: 'simulator', NODE_ENV: 'production' }),
      ),
    ).toThrow('The payment simulator cannot run with NODE_ENV=production');
  });

  it.each([undefined, '', 'stripe'])(
    'refuses a missing or unsupported provider (%p)',
    (provider) => {
      expect(() =>
        createPaymentProvider(
          config({ PAYMENT_PROVIDER: provider, NODE_ENV: 'development' }),
        ),
      ).toThrow('PAYMENT_PROVIDER does not name a supported provider');
    },
  );
});
