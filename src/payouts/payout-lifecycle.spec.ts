import { describe, expect, it } from '@jest/globals';
import { PayoutFailureCode, PayoutStatus } from '../generated/prisma/enums.js';
import {
  matchesRecordedPayout,
  PAYOUT_TRANSITIONS,
  payoutStatusesThatCanBecome,
  resolvePayout,
} from './payout-lifecycle.js';

describe('payout lifecycle', () => {
  it('only lets a pending payout reach an outcome, and never reopens one', () => {
    expect(PAYOUT_TRANSITIONS).toEqual({
      PENDING: ['SUCCEEDED', 'FAILED'],
      SUCCEEDED: [],
      FAILED: [],
    });
    expect(payoutStatusesThatCanBecome(PayoutStatus.FAILED)).toEqual([
      PayoutStatus.PENDING,
    ]);
    expect(payoutStatusesThatCanBecome(PayoutStatus.PENDING)).toEqual([]);
  });

  it.each([
    [
      { outcome: 'succeeded', providerReference: 'simpo_1' },
      { status: 'SUCCEEDED', providerReference: 'simpo_1', failureCode: null },
    ],
    [
      { outcome: 'declined', providerReference: 'simpo_2' },
      {
        status: 'FAILED',
        providerReference: 'simpo_2',
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
    expect(resolvePayout(result)).toEqual(expected);
  });

  it('refuses an unrecognised provider outcome instead of guessing', () => {
    expect(() =>
      resolvePayout({ outcome: 'returned' } as unknown as Parameters<
        typeof resolvePayout
      >[0]),
    ).toThrow(/Unrecognised provider outcome: "returned"/);
  });

  it('treats agreeing answers as duplicates and different ones as contradictions', () => {
    const recorded = {
      status: PayoutStatus.SUCCEEDED,
      failureCode: null,
      providerReference: 'simpo_1',
    };
    expect(
      matchesRecordedPayout(
        recorded,
        resolvePayout({ outcome: 'succeeded', providerReference: 'simpo_1' }),
      ),
    ).toBe(true);
    expect(
      matchesRecordedPayout(
        recorded,
        resolvePayout({ outcome: 'declined', providerReference: 'simpo_1' }),
      ),
    ).toBe(false);
    expect(
      matchesRecordedPayout(
        {
          status: PayoutStatus.FAILED,
          failureCode: PayoutFailureCode.PROVIDER_UNAVAILABLE,
          providerReference: null,
        },
        resolvePayout({ outcome: 'unavailable' }),
      ),
    ).toBe(true);
  });
});
