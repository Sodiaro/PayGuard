import { describe, expect, it } from '@jest/globals';
import {
  PaymentAttemptStatus as Attempt,
  CaptureMethod,
  PaymentFailureCode,
  PaymentStatus as Payment,
} from '../generated/prisma/enums.js';
import {
  attemptStatusesThatCanBecome,
  CaptureMethodMismatchError,
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
    [Payment.PENDING, Payment.AUTHORIZED, true],
    [Payment.FAILED, Payment.PENDING, true],
    [Payment.AUTHORIZED, Payment.SUCCEEDED, true],
    [Payment.AUTHORIZED, Payment.CANCELED, true],
    [Payment.AUTHORIZED, Payment.FAILED, false],
    [Payment.AUTHORIZED, Payment.PENDING, false],
    [Payment.PENDING, Payment.CANCELED, false],
    [Payment.SUCCEEDED, Payment.FAILED, false],
    [Payment.SUCCEEDED, Payment.PENDING, false],
    [Payment.FAILED, Payment.SUCCEEDED, false],
    [Payment.PENDING, Payment.PENDING, false],
  ])('%s -> %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionPayment(from, to)).toBe(allowed);
  });

  it.each([Payment.SUCCEEDED, Payment.CANCELED])(
    'treats %s as terminal',
    (terminal) => {
      for (const to of Object.values(Payment)) {
        expect(canTransitionPayment(terminal, to)).toBe(false);
      }
    },
  );

  it('derives the conditional-update guards from the same table', () => {
    expect(paymentStatusesThatCanBecome(Payment.SUCCEEDED)).toEqual([
      Payment.PENDING,
      Payment.AUTHORIZED,
    ]);
    expect(paymentStatusesThatCanBecome(Payment.FAILED)).toEqual([
      Payment.PENDING,
    ]);
    expect(paymentStatusesThatCanBecome(Payment.PENDING)).toEqual([
      Payment.FAILED,
    ]);
    expect(paymentStatusesThatCanBecome(Payment.CANCELED)).toEqual([
      Payment.AUTHORIZED,
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
  const { AUTOMATIC, MANUAL } = CaptureMethod;

  it('maps a success to SUCCEEDED on both records', () => {
    expect(
      resolveAttempt(
        { outcome: 'succeeded', providerReference: 'sim_1' },
        AUTOMATIC,
      ),
    ).toEqual({
      attemptStatus: Attempt.SUCCEEDED,
      paymentStatus: Payment.SUCCEEDED,
      providerReference: 'sim_1',
      failureCode: null,
    });
  });

  it('maps an authorization to a succeeded attempt and an AUTHORIZED payment', () => {
    expect(
      resolveAttempt(
        { outcome: 'authorized', providerReference: 'sim_1' },
        MANUAL,
      ),
    ).toEqual({
      attemptStatus: Attempt.SUCCEEDED,
      paymentStatus: Payment.AUTHORIZED,
      providerReference: 'sim_1',
      failureCode: null,
    });
  });

  it.each([
    ['a charge for a manual-capture payment', 'succeeded', MANUAL],
    ['an authorization for an automatic payment', 'authorized', AUTOMATIC],
  ] as const)(
    'refuses %s, which PayGuard never asked for',
    (_case, outcome, captureMethod) => {
      expect(() =>
        resolveAttempt({ outcome, providerReference: 'sim_1' }, captureMethod),
      ).toThrow(CaptureMethodMismatchError);
    },
  );

  it.each([AUTOMATIC, MANUAL])(
    'maps a decline to FAILED with DECLINED for %s capture',
    (captureMethod) => {
      expect(
        resolveAttempt(
          { outcome: 'declined', providerReference: 'sim_2' },
          captureMethod,
        ),
      ).toMatchObject({
        attemptStatus: Attempt.FAILED,
        paymentStatus: Payment.FAILED,
        failureCode: PaymentFailureCode.DECLINED,
      });
    },
  );

  it('never reports an outage as a decline', () => {
    expect(resolveAttempt({ outcome: 'unavailable' }, AUTOMATIC)).toEqual({
      attemptStatus: Attempt.FAILED,
      paymentStatus: Payment.FAILED,
      providerReference: null,
      failureCode: PaymentFailureCode.PROVIDER_UNAVAILABLE,
    });
  });

  it('refuses outcomes it does not recognise instead of guessing', () => {
    const bogus = { outcome: 'maybe' } as unknown as ProviderPaymentResult;
    expect(() => resolveAttempt(bogus, AUTOMATIC)).toThrow(
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
