import { describe, expect, it } from '@jest/globals';
import {
  PaymentAttemptStatus,
  PaymentStatus,
  RefundFailureCode,
  RefundStatus,
} from '../generated/prisma/enums.js';
import {
  matchesRecordedRefund,
  REFUND_TRANSITIONS,
  refundableAmount,
  refundEligibility,
  refundStatusesThatCanBecome,
  resolveRefund,
} from './refund-lifecycle.js';

const succeeded = { status: PaymentStatus.SUCCEEDED, amount: 10_000n };
const charge = [
  { id: 'attempt-1', status: PaymentAttemptStatus.FAILED },
  { id: 'attempt-2', status: PaymentAttemptStatus.SUCCEEDED },
];
const refund = (amount: bigint, status: RefundStatus) => ({ amount, status });

describe('refund lifecycle', () => {
  it('only lets a pending refund reach an outcome, and never reopens one', () => {
    expect(REFUND_TRANSITIONS).toEqual({
      PENDING: ['SUCCEEDED', 'FAILED'],
      SUCCEEDED: [],
      FAILED: [],
    });
    expect(refundStatusesThatCanBecome(RefundStatus.SUCCEEDED)).toEqual([
      RefundStatus.PENDING,
    ]);
    expect(refundStatusesThatCanBecome(RefundStatus.PENDING)).toEqual([]);
  });

  it.each([
    [
      { outcome: 'succeeded', providerReference: 'simrf_1' },
      { status: 'SUCCEEDED', providerReference: 'simrf_1', failureCode: null },
    ],
    [
      { outcome: 'declined', providerReference: 'simrf_2' },
      {
        status: 'FAILED',
        providerReference: 'simrf_2',
        failureCode: 'DECLINED',
      },
    ],
    [
      { outcome: 'unavailable' },
      {
        status: 'FAILED',
        providerReference: null,
        failureCode: 'PROVIDER_UNAVAILABLE',
      },
    ],
  ] as const)('maps %j to its resolution', (result, expected) => {
    expect(resolveRefund(result)).toEqual(expected);
  });

  it('refuses an unrecognised provider outcome instead of guessing', () => {
    expect(() =>
      resolveRefund({ outcome: 'reversed' } as unknown as Parameters<
        typeof resolveRefund
      >[0]),
    ).toThrow(/Unrecognised provider outcome: "reversed"/);
  });

  it('treats agreeing answers as duplicates and different ones as contradictions', () => {
    const recorded = {
      status: RefundStatus.SUCCEEDED,
      failureCode: null,
      providerReference: 'simrf_1',
    };
    expect(
      matchesRecordedRefund(
        recorded,
        resolveRefund({
          outcome: 'succeeded',
          providerReference: 'simrf_1',
        }),
      ),
    ).toBe(true);
    expect(
      matchesRecordedRefund(
        recorded,
        resolveRefund({
          outcome: 'declined',
          providerReference: 'simrf_1',
        }),
      ),
    ).toBe(false);
    expect(
      matchesRecordedRefund(
        {
          status: RefundStatus.FAILED,
          failureCode: RefundFailureCode.PROVIDER_UNAVAILABLE,
          providerReference: null,
        },
        resolveRefund({ outcome: 'unavailable' }),
      ),
    ).toBe(true);
  });

  it('counts pending and succeeded refunds against the payment, but not failed ones', () => {
    expect(
      refundableAmount(succeeded, [
        refund(2_000n, RefundStatus.SUCCEEDED),
        refund(3_000n, RefundStatus.PENDING),
        refund(5_000n, RefundStatus.FAILED),
      ]),
    ).toBe(5_000n);
  });

  describe('eligibility', () => {
    it('refunds everything still refundable when no amount is given, against the succeeded attempt', () => {
      expect(
        refundEligibility(
          succeeded,
          charge,
          [refund(4_000n, RefundStatus.SUCCEEDED)],
          null,
        ),
      ).toEqual({ eligible: true, amount: 6_000n, attemptId: 'attempt-2' });
    });

    it('accepts a partial refund up to exactly what is left', () => {
      expect(
        refundEligibility(
          succeeded,
          charge,
          [refund(4_000n, RefundStatus.PENDING)],
          6_000n,
        ),
      ).toMatchObject({ eligible: true, amount: 6_000n });
    });

    it.each([
      [
        'a pending payment',
        { status: PaymentStatus.PENDING, amount: 10_000n },
        [{ id: 'a', status: PaymentAttemptStatus.PENDING }],
        [],
        null,
        'payment_not_succeeded',
      ],
      [
        'a failed payment',
        { status: PaymentStatus.FAILED, amount: 10_000n },
        [{ id: 'a', status: PaymentAttemptStatus.FAILED }],
        [],
        null,
        'payment_not_succeeded',
      ],
      [
        'a fully refunded payment',
        succeeded,
        charge,
        [refund(10_000n, RefundStatus.SUCCEEDED)],
        null,
        'nothing_left_to_refund',
      ],
      [
        'a payment whose remainder is pending',
        succeeded,
        charge,
        [refund(10_000n, RefundStatus.PENDING)],
        1n,
        'nothing_left_to_refund',
      ],
      [
        'more than is left',
        succeeded,
        charge,
        [refund(9_000n, RefundStatus.SUCCEEDED)],
        1_001n,
        'amount_exceeds_refundable',
      ],
    ] as const)(
      'refuses %s',
      (_case, payment, attempts, refunds, amount, reason) => {
        expect(refundEligibility(payment, attempts, refunds, amount)).toEqual({
          eligible: false,
          reason,
        });
      },
    );
  });
});
