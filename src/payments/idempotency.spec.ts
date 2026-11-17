import { describe, expect, it } from '@jest/globals';
import {
  fingerprintPaymentRequest,
  fingerprintRefundRequest,
  idempotencyKeyProblem,
} from './idempotency.js';

describe('fingerprintRefundRequest', () => {
  const paymentId = '01a16b6d-bf6d-765f-98fb-39c95d75fe23';

  it('distinguishes payment, amount, reference, and a full refund from any explicit amount', () => {
    const fingerprints = [
      fingerprintRefundRequest(paymentId, {}),
      fingerprintRefundRequest(paymentId, { amount: 100 }),
      fingerprintRefundRequest(paymentId, { amount: 101 }),
      fingerprintRefundRequest(paymentId, { amount: 100, reference: 'r1' }),
      fingerprintRefundRequest('01a16b6d-bf6d-765f-98fb-39c95d75fe24', {
        amount: 100,
      }),
    ];

    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    for (const fingerprint of fingerprints) {
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(fingerprintRefundRequest(paymentId, { amount: 100 })).toBe(
      fingerprints[1],
    );
  });
});

describe('idempotencyKeyProblem', () => {
  it.each([
    '0f8fad5b-d9cb-469f-a165-70867728950e',
    'order-10042:attempt#1',
    'x',
    'k'.repeat(255),
  ])('accepts %j', (key) => {
    expect(idempotencyKeyProblem(key)).toBeNull();
  });

  it.each([
    [undefined, 'required'],
    ['', 'required'],
    ['   ', 'required'],
    ['has space', 'visible ASCII'],
    ['tab\there', 'visible ASCII'],
    ['café', 'visible ASCII'],
    ['k'.repeat(256), 'visible ASCII'],
  ])('rejects %j', (key, message) => {
    expect(idempotencyKeyProblem(key)).toContain(message);
  });
});

describe('fingerprintPaymentRequest', () => {
  const base = { amount: 500000, currency: 'NGN', reference: 'order_1' };

  it('is a stable SHA-256 hex digest', () => {
    const fingerprint = fingerprintPaymentRequest(base);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintPaymentRequest({ ...base })).toBe(fingerprint);
  });

  it('ignores property order and treats a missing reference as null', () => {
    expect(
      fingerprintPaymentRequest({
        reference: 'order_1',
        currency: 'NGN',
        amount: 500000,
      }),
    ).toBe(fingerprintPaymentRequest(base));
    expect(fingerprintPaymentRequest({ amount: 1, currency: 'USD' })).toBe(
      fingerprintPaymentRequest({
        amount: 1,
        currency: 'USD',
        reference: null,
      }),
    );
  });

  it.each([
    ['amount', { ...base, amount: 500001 }],
    ['currency', { ...base, currency: 'GHS' }],
    ['reference', { ...base, reference: 'order_2' }],
    ['removed reference', { amount: 500000, currency: 'NGN' }],
  ])('changes when the %s changes', (_field, changed) => {
    expect(fingerprintPaymentRequest(changed)).not.toBe(
      fingerprintPaymentRequest(base),
    );
  });
});
