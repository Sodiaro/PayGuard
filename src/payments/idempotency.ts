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
  captureMethod?: 'AUTOMATIC' | 'MANUAL';
}

// Fingerprints are stored with each payment, so any change to this canonical form must bump the
// version tag; otherwise replays of existing keys would start returning 409. Automatic capture,
// explicit or by default, keeps the v1 form, so payments created before manual capture existed
// still replay.
export function fingerprintPaymentRequest(
  request: CanonicalPaymentRequest,
): string {
  const fields = [request.amount, request.currency, request.reference ?? null];
  const canonical = JSON.stringify(
    request.captureMethod === 'MANUAL'
      ? ['payments.create.v2', ...fields, 'MANUAL']
      : ['payments.create.v1', ...fields],
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// Capture and void have no reference; a capture without an amount captures the whole
// authorization and is its own request, distinct from any explicit amount.
export function fingerprintPaymentActionRequest(
  paymentId: string,
  type: 'CAPTURE' | 'VOID',
  amount?: number,
): string {
  const canonical = JSON.stringify([
    'payments.action.v1',
    paymentId,
    type,
    amount ?? null,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// A retry has no body, so the logical request is the payment being retried.
export function fingerprintRetryRequest(paymentId: string): string {
  const canonical = JSON.stringify(['payments.retry.v1', paymentId]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function fingerprintPayoutRequest(request: {
  amount: number;
  currency: string;
  destination: { bankCode: string; accountNumber: string; accountName: string };
  reference?: string;
}): string {
  const canonical = JSON.stringify([
    'payouts.create.v1',
    request.amount,
    request.currency,
    request.destination.bankCode,
    request.destination.accountNumber,
    request.destination.accountName,
    request.reference ?? null,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// An omitted amount ("everything refundable") is its own request, distinct from any explicit one.
export function fingerprintRefundRequest(
  paymentId: string,
  request: { amount?: number; reference?: string },
): string {
  const canonical = JSON.stringify([
    'refunds.create.v1',
    paymentId,
    request.amount ?? null,
    request.reference ?? null,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
