import { describe, expect, it } from '@jest/globals';
import { ProviderTimeoutError } from './payment-provider.js';
import {
  SimulatedPaymentProvider,
  SimulatorOutcome,
} from './simulated-payment-provider.js';

const request = {
  attemptId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  merchantId: '0190a1b2-0000-7000-8000-000000000000',
  amount: 500000,
  currency: 'NGN',
};

describe('SimulatedPaymentProvider', () => {
  it('succeeds with a simulated, attempt-derived reference', async () => {
    const result = await new SimulatedPaymentProvider(
      SimulatorOutcome.Succeeded,
    ).processPayment(request);

    expect(result).toEqual({
      outcome: 'succeeded',
      providerReference: expect.stringMatching(/^sim_[0-9a-f]{24}$/),
    });
  });

  it('declines with a reference', async () => {
    const result = await new SimulatedPaymentProvider(
      SimulatorOutcome.Declined,
    ).processPayment(request);

    expect(result).toMatchObject({
      outcome: 'declined',
      providerReference: expect.stringMatching(/^sim_/),
    });
  });

  it('reports unavailability without a reference', async () => {
    const result = await new SimulatedPaymentProvider(
      SimulatorOutcome.Unavailable,
    ).processPayment(request);

    expect(result).toEqual({ outcome: 'unavailable' });
  });

  it('is deterministic per attempt and distinct across attempts', async () => {
    const provider = new SimulatedPaymentProvider(SimulatorOutcome.Succeeded);
    const first = await provider.processPayment(request);
    const again = await provider.processPayment(request);
    const other = await provider.processPayment({
      ...request,
      attemptId: 'another-attempt',
    });

    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it.each([
    [SimulatorOutcome.Succeeded, 'succeeded'],
    [SimulatorOutcome.Declined, 'declined'],
  ])(
    'looks up a %s attempt with the same reference it was processed with',
    async (outcome, status) => {
      const provider = new SimulatedPaymentProvider(outcome);
      const processed = await provider.processPayment(request);

      await expect(
        provider.lookupPayment({ attemptId: request.attemptId }),
      ).resolves.toEqual({
        status,
        providerReference: (processed as { providerReference: string })
          .providerReference,
      });
    },
  );

  it('reports an attempt it refused as unknown to lookup', async () => {
    const provider = new SimulatedPaymentProvider(SimulatorOutcome.Unavailable);

    await expect(
      provider.lookupPayment({ attemptId: request.attemptId }),
    ).resolves.toEqual({ status: 'not_found' });
  });

  it('can lose submission answers while lookups still return the outcome, across instances', async () => {
    const beforeRestart = new SimulatedPaymentProvider(
      SimulatorOutcome.Succeeded,
      true,
    );
    await expect(beforeRestart.processPayment(request)).rejects.toBeInstanceOf(
      ProviderTimeoutError,
    );

    const afterRestart = new SimulatedPaymentProvider(
      SimulatorOutcome.Succeeded,
      true,
    );
    await expect(
      afterRestart.lookupPayment({ attemptId: request.attemptId }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });

  describe('refunds', () => {
    const refund = {
      refundId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c',
      attemptId: request.attemptId,
      providerReference: 'sim_0123456789abcdef01234567',
      amount: 150000,
      currency: 'NGN',
    };

    it('follows the refund outcome, independently of the payment outcome', async () => {
      const provider = new SimulatedPaymentProvider(
        SimulatorOutcome.Succeeded,
        false,
        SimulatorOutcome.Declined,
      );

      await expect(provider.processPayment(request)).resolves.toMatchObject({
        outcome: 'succeeded',
      });
      await expect(provider.processRefund(refund)).resolves.toEqual({
        outcome: 'declined',
        providerReference: expect.stringMatching(/^simrf_[0-9a-f]{24}$/),
      });
    });

    it('defaults to succeeding refunds', async () => {
      await expect(
        new SimulatedPaymentProvider(SimulatorOutcome.Declined).processRefund(
          refund,
        ),
      ).resolves.toMatchObject({ outcome: 'succeeded' });
    });

    it('looks a refund up with the reference it was processed with, and refused ones as unknown', async () => {
      const provider = new SimulatedPaymentProvider(SimulatorOutcome.Succeeded);
      const processed = await provider.processRefund(refund);

      await expect(
        provider.lookupRefund({ refundId: refund.refundId }),
      ).resolves.toEqual({
        status: 'succeeded',
        providerReference: (processed as { providerReference: string })
          .providerReference,
      });
      await expect(
        new SimulatedPaymentProvider(
          SimulatorOutcome.Succeeded,
          false,
          SimulatorOutcome.Unavailable,
        ).lookupRefund({ refundId: refund.refundId }),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('loses refund answers too when submissions are ambiguous', async () => {
      const provider = new SimulatedPaymentProvider(
        SimulatorOutcome.Succeeded,
        true,
      );

      await expect(provider.processRefund(refund)).rejects.toBeInstanceOf(
        ProviderTimeoutError,
      );
      await expect(
        provider.lookupRefund({ refundId: refund.refundId }),
      ).resolves.toMatchObject({ status: 'succeeded' });
    });
  });
});
