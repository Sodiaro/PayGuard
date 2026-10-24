import { describe, expect, it } from '@jest/globals';
import {
  PaymentAttemptStatus as Attempt,
  PaymentFailureCode,
  PaymentStatus as Payment,
} from '../generated/prisma/enums.js';
import {
  attemptStatusesThatCanBecome,
  canTransitionAttempt,
  canTransitionPayment,
  MAX_ATTEMPTS_PER_PAYMENT,
  paymentStatusesThatCanBecome,
  resolveAttempt,
  retryEligibility,
} from './payment-lifecycle.js';
import type { ProviderPaymentResult } from './providers/payment-provider.js';

describe('payment transitions', () => {
  it.each([
    [Payment.PENDING, Payment.SUCCEEDED, true],
    [Payment.PENDING, Payment.FAILED, true],
    [Payment.FAILED, Payment.PENDING, true],
    [Payment.SUCCEEDED, Payment.FAILED, false],
    [Payment.SUCCEEDED, Payment.PENDING, false],
    [Payment.FAILED, Payment.SUCCEEDED, false],
    [Payment.PENDING, Payment.PENDING, false],
  ])('%s -> %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionPayment(from, to)).toBe(allowed);
  });

  it('treats SUCCEEDED as terminal', () => {
    for (const to of Object.values(Payment)) {
      expect(canTransitionPayment(Payment.SUCCEEDED, to)).toBe(false);
    }
  });

  it('derives the conditional-update guards from the same table', () => {
    expect(paymentStatusesThatCanBecome(Payment.SUCCEEDED)).toEqual([
      Payment.PENDING,
    ]);
    expect(paymentStatusesThatCanBecome(Payment.FAILED)).toEqual([
      Payment.PENDING,
    ]);
    expect(paymentStatusesThatCanBecome(Payment.PENDING)).toEqual([
      Payment.FAILED,
    ]);
  });
});

describe('attempt transitions', () => {
  it('only lets a PENDING attempt reach an outcome, exactly once', () => {
    expect(canTransitionAttempt(Attempt.PENDING, Attempt.SUCCEEDED)).toBe(true);
    expect(canTransitionAttempt(Attempt.PENDING, Attempt.FAILED)).toBe(true);
    for (const terminal of [Attempt.SUCCEEDED, Attempt.FAILED]) {
      for (const to of Object.values(Attempt)) {
        expect(canTransitionAttempt(terminal, to)).toBe(false);
      }
    }
    expect(attemptStatusesThatCanBecome(Attempt.FAILED)).toEqual([
      Attempt.PENDING,
    ]);
    expect(attemptStatusesThatCanBecome(Attempt.PENDING)).toEqual([]);
  });
});

describe('resolveAttempt', () => {
  it('maps a success to SUCCEEDED on both records', () => {
    expect(
      resolveAttempt({ outcome: 'succeeded', providerReference: 'sim_1' }),
    ).toEqual({
      attemptStatus: Attempt.SUCCEEDED,
      paymentStatus: Payment.SUCCEEDED,
      providerReference: 'sim_1',
      failureCode: null,
    });
  });

  it('maps a decline to FAILED with DECLINED', () => {
    expect(
      resolveAttempt({ outcome: 'declined', providerReference: 'sim_2' }),
    ).toMatchObject({
      attemptStatus: Attempt.FAILED,
      paymentStatus: Payment.FAILED,
      failureCode: PaymentFailureCode.DECLINED,
    });
  });

  it('never reports an outage as a decline', () => {
    expect(resolveAttempt({ outcome: 'unavailable' })).toEqual({
      attemptStatus: Attempt.FAILED,
      paymentStatus: Payment.FAILED,
      providerReference: null,
      failureCode: PaymentFailureCode.PROVIDER_UNAVAILABLE,
    });
  });

  it('refuses outcomes it does not recognise instead of guessing', () => {
    const bogus = { outcome: 'maybe' } as unknown as ProviderPaymentResult;
    expect(() => resolveAttempt(bogus)).toThrow(
      /Unrecognised provider outcome/,
    );
  });
});

describe('retryEligibility', () => {
  const failed = (failureCode: PaymentFailureCode) => ({
    status: Attempt.FAILED,
    failureCode,
  });

  it('allows a new attempt after a decline or an outage', () => {
    for (const code of [
      PaymentFailureCode.DECLINED,
      PaymentFailureCode.PROVIDER_UNAVAILABLE,
    ]) {
      expect(
        retryEligibility({ status: Payment.FAILED }, [failed(code)]),
      ).toEqual({
        eligible: true,
      });
    }
  });

  it.each([
    ['a succeeded payment', Payment.SUCCEEDED, [], 'payment_not_failed'],
    ['a pending payment', Payment.PENDING, [], 'payment_not_failed'],
    [
      'an attempt still in flight',
      Payment.FAILED,
      [{ status: Attempt.PENDING, failureCode: null }],
      'attempt_in_progress',
    ],
    [
      'the attempt limit',
      Payment.FAILED,
      Array.from({ length: MAX_ATTEMPTS_PER_PAYMENT }, () => ({
        status: Attempt.FAILED,
        failureCode: PaymentFailureCode.DECLINED,
      })),
      'attempt_limit_reached',
    ],
  ])('refuses %s', (_case, status, attempts, reason) => {
    expect(retryEligibility({ status }, attempts)).toEqual({
      eligible: false,
      reason,
    });
  });
});
