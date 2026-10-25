import { createHash } from 'node:crypto';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

// Visible ASCII only, so keys compare byte-for-byte and are safe to store and log.
const IDEMPOTENCY_KEY_FORMAT = /^[\x21-\x7E]{1,255}$/;

export function idempotencyKeyProblem(
  value: string | undefined,
): string | null {
  if (value === undefined || value.trim() === '') {
    return 'Idempotency-Key header is required';
  }
  if (!IDEMPOTENCY_KEY_FORMAT.test(value)) {
    return 'Idempotency-Key must be 1-255 visible ASCII characters without spaces';
  }
  return null;
}

export interface CanonicalPaymentRequest {
  amount: number;
  currency: string;
  reference?: string | null;
}

// Fingerprints are stored with each payment, so any change to this canonical form must bump the
// version tag; otherwise replays of existing keys would start returning 409.
export function fingerprintPaymentRequest(
  request: CanonicalPaymentRequest,
): string {
  const canonical = JSON.stringify([
    'payments.create.v1',
    request.amount,
    request.currency,
    request.reference ?? null,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// A retry has no body, so the logical request is the payment being retried.
export function fingerprintRetryRequest(paymentId: string): string {
  const canonical = JSON.stringify(['payments.retry.v1', paymentId]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
