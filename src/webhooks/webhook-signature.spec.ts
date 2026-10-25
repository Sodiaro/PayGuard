import { describe, expect, it } from '@jest/globals';
import { createHmac } from 'node:crypto';
import {
  computeWebhookSignature,
  verifyWebhookSignature,
  webhookSignatureHeader,
} from './webhook-signature.js';

const SECRET = 'unit-test-webhook-secret-0123456789abcdef';
const NOW = 1_790_000_000;
const BODY = Buffer.from('{"id":"evt_0123456789","type":"payment.succeeded"}');

function verify(
  header: string | string[] | undefined,
  overrides: { rawBody?: Buffer; nowSeconds?: number; secret?: string } = {},
) {
  return verifyWebhookSignature({
    secret: overrides.secret ?? SECRET,
    header,
    rawBody: overrides.rawBody ?? BODY,
    nowSeconds: overrides.nowSeconds ?? NOW,
    toleranceSeconds: 300,
  });
}

describe('webhook signatures', () => {
  it('signs "<timestamp>." followed by the raw body with HMAC-SHA256', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`${NOW}.${BODY.toString('utf8')}`)
      .digest('hex');

    expect(computeWebhookSignature(SECRET, NOW, BODY)).toBe(expected);
    expect(webhookSignatureHeader(SECRET, NOW, BODY)).toBe(
      `t=${NOW},v1=${expected}`,
    );
  });

  it('accepts a valid signature and returns its signed timestamp', () => {
    expect(verify(webhookSignatureHeader(SECRET, NOW - 10, BODY))).toEqual({
      valid: true,
      timestamp: NOW - 10,
    });
  });

  it('rejects a signature made with another secret', () => {
    const header = webhookSignatureHeader('another-secret-entirely', NOW, BODY);
    expect(verify(header)).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('verifies the exact bytes: re-serialized JSON with the same meaning fails', () => {
    const header = webhookSignatureHeader(SECRET, NOW, BODY);
    const reformatted = Buffer.from(
      JSON.stringify(JSON.parse(BODY.toString('utf8')), null, 2),
    );
    const tampered = Buffer.from(BODY);
    tampered[tampered.length - 2] ^= 1;

    expect(verify(header, { rawBody: reformatted })).toMatchObject({
      valid: false,
      reason: 'mismatch',
    });
    expect(verify(header, { rawBody: tampered })).toMatchObject({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects a timestamp changed after signing', () => {
    const signature = computeWebhookSignature(SECRET, NOW - 400, BODY);
    expect(verify(`t=${NOW},v1=${signature}`)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it.each([
    ['too old', NOW - 301, 'timestamp_too_old'],
    ['too far in the future', NOW + 301, 'timestamp_in_future'],
  ])('rejects a timestamp %s', (_case, timestamp, reason) => {
    expect(verify(webhookSignatureHeader(SECRET, timestamp, BODY))).toEqual({
      valid: false,
      reason,
    });
  });

  it('accepts timestamps at the edge of the tolerance', () => {
    for (const timestamp of [NOW - 300, NOW + 300]) {
      expect(
        verify(webhookSignatureHeader(SECRET, timestamp, BODY)).valid,
      ).toBe(true);
    }
  });

  it.each([undefined, ''])('rejects a missing header (%p)', (header) => {
    expect(verify(header)).toEqual({ valid: false, reason: 'missing' });
  });

  const valid = computeWebhookSignature(SECRET, NOW, BODY);
  it.each([
    ['no timestamp', `v1=${valid}`],
    ['no signature', `t=${NOW}`],
    ['reordered fields', `v1=${valid},t=${NOW}`],
    ['uppercase hex', `t=${NOW},v1=${valid.toUpperCase()}`],
    ['short signature', `t=${NOW},v1=${valid.slice(0, 62)}`],
    ['long signature', `t=${NOW},v1=${valid}00`],
    [
      'base64 signature',
      `t=${NOW},v1=${Buffer.from(valid, 'hex').toString('base64')}`,
    ],
    ['non-numeric timestamp', `t=soon,v1=${valid}`],
    ['millisecond timestamp', `t=${NOW}000,v1=${valid}`],
    ['extra field', `t=${NOW},v1=${valid},v0=${valid}`],
    ['whitespace', `t=${NOW}, v1=${valid}`],
    ['oversized header', `t=${NOW},v1=${valid}${'0'.repeat(200)}`],
  ])('rejects a malformed header: %s', (_case, header) => {
    expect(verify(header)).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects a repeated header instead of choosing one', () => {
    const header = webhookSignatureHeader(SECRET, NOW, BODY);
    expect(verify([header, header])).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });
});
