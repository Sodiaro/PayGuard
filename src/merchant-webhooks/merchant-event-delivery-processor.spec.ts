import { describe, expect, it } from '@jest/globals';
import { verifyWebhookSignature } from '../webhooks/webhook-signature.js';
import {
  deliveryBackoffSeconds,
  signatureHeader,
} from './merchant-event-delivery-processor.js';

describe('merchant event delivery', () => {
  it('backs off from 30 seconds, doubling, up to an hour', () => {
    expect([1, 2, 3, 4, 7, 8, 9, 20].map(deliveryBackoffSeconds)).toEqual([
      30, 60, 120, 240, 1920, 3600, 3600, 3600,
    ]);
  });

  it('signs with every active secret, so either verifies during a rotation', () => {
    const body = '{"id":"evt","type":"payment.succeeded"}';
    const header = signatureHeader(
      ['whsec_new', 'whsec_old'],
      1792843200,
      body,
    );

    expect(header).toMatch(/^t=1792843200,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    for (const [index, secret] of ['whsec_new', 'whsec_old'].entries()) {
      const single = `t=1792843200,v1=${header.split(',v1=')[index + 1]}`;
      expect(
        verifyWebhookSignature({
          secret,
          header: single,
          rawBody: Buffer.from(body),
          nowSeconds: 1792843200,
          toleranceSeconds: 300,
        }),
      ).toEqual({ valid: true, timestamp: 1792843200 });
    }
    expect(signatureHeader(['whsec_new'], 1, body)).toMatch(
      /^t=1,v1=[0-9a-f]{64}$/,
    );
  });
});
