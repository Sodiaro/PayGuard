import { describe, expect, it } from '@jest/globals';
import {
  fingerprintPaymentRequest,
  idempotencyKeyProblem,
} from './idempotency.js';

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
