import { describe, expect, it } from '@jest/globals';
import {
  CaptureMethod,
  PaymentActionStatus,
  PaymentActionType,
  PaymentAttemptStatus,
  PaymentStatus,
} from '../generated/prisma/enums.js';
import {
  actionEligibility,
  actionStatusesThatCanBecome,
  PAYMENT_STATUS_AFTER,
  resolveAction,
} from './payment-action-lifecycle.js';

const authorized = {
  status: PaymentStatus.AUTHORIZED,
  captureMethod: CaptureMethod.MANUAL,
  amount: 10_000n,
};
const attempts = [
  { id: 'attempt-1', status: PaymentAttemptStatus.FAILED },
  { id: 'attempt-2', status: PaymentAttemptStatus.SUCCEEDED },
];

describe('payment action lifecycle', () => {
  it('only lets a pending action reach an outcome', () => {
    expect(actionStatusesThatCanBecome(PaymentActionStatus.SUCCEEDED)).toEqual([
      PaymentActionStatus.PENDING,
    ]);
    expect(actionStatusesThatCanBecome(PaymentActionStatus.PENDING)).toEqual(
      [],
    );
  });

  it('moves an authorized payment to SUCCEEDED on capture and CANCELED on void', () => {
    expect(PAYMENT_STATUS_AFTER).toEqual({
      CAPTURE: PaymentStatus.SUCCEEDED,
      VOID: PaymentStatus.CANCELED,
    });
  });

  it.each([
    [
      { outcome: 'succeeded', providerReference: 'simcp_1' },
      { status: 'SUCCEEDED', providerReference: 'simcp_1', failureCode: null },
    ],
    [
      { outcome: 'declined', providerReference: null },
      { status: 'FAILED', providerReference: null, failureCode: 'DECLINED' },
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
    expect(resolveAction(result)).toEqual(expected);
  });

  describe('eligibility', () => {
    it('captures the whole authorization by default, through the succeeded attempt', () => {
      expect(
        actionEligibility(
          authorized,
          attempts,
          [],
          PaymentActionType.CAPTURE,
          null,
        ),
      ).toEqual({ eligible: true, attemptId: 'attempt-2', amount: 10_000n });
    });

    it('accepts a partial capture, a void, and a new try after a failed action', () => {
      expect(
        actionEligibility(
          authorized,
          attempts,
          [{ status: PaymentActionStatus.FAILED }],
          PaymentActionType.CAPTURE,
          4_000n,
        ),
      ).toMatchObject({ eligible: true, amount: 4_000n });
      expect(
        actionEligibility(
          authorized,
          attempts,
          [],
          PaymentActionType.VOID,
          null,
        ),
      ).toEqual({ eligible: true, attemptId: 'attempt-2', amount: null });
    });

    it.each([
      [
        'an automatic payment',
        { ...authorized, captureMethod: CaptureMethod.AUTOMATIC },
        [],
        PaymentActionType.CAPTURE,
        null,
        'payment_not_authorized',
      ],
      [
        'a pending manual payment',
        { ...authorized, status: PaymentStatus.PENDING },
        [],
        PaymentActionType.VOID,
        null,
        'payment_not_authorized',
      ],
      [
        'a captured payment',
        { ...authorized, status: PaymentStatus.SUCCEEDED },
        [],
        PaymentActionType.CAPTURE,
        null,
        'payment_not_authorized',
      ],
      [
        'a voided payment',
        { ...authorized, status: PaymentStatus.CANCELED },
        [],
        PaymentActionType.VOID,
        null,
        'payment_not_authorized',
      ],
      [
        'a payment with an action in flight',
        authorized,
        [{ status: PaymentActionStatus.PENDING }],
        PaymentActionType.VOID,
        null,
        'action_in_progress',
      ],
      [
        'more than was authorized',
        authorized,
        [],
        PaymentActionType.CAPTURE,
        10_001n,
        'amount_exceeds_authorized',
      ],
    ] as const)(
      'refuses %s',
      (_case, payment, actions, type, amount, reason) => {
        expect(
          actionEligibility(payment, attempts, actions, type, amount),
        ).toEqual({ eligible: false, reason });
      },
    );
  });
});
