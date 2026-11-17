import { describe, expect, it } from '@jest/globals';
import {
  generateWebhookSecret,
  WebhookSecretCipher,
} from './webhook-secrets.js';

const KEY = '7e'.repeat(32);
const MERCHANT = '0190a1b2-0000-7000-8000-000000000001';
const OTHER_MERCHANT = '0190a1b2-0000-7000-8000-000000000002';

describe('webhook secrets', () => {
  it('generates distinct, prefixed secrets with 256 bits of randomness', () => {
    const secrets = new Set(Array.from({ length: 50 }, generateWebhookSecret));

    expect(secrets.size).toBe(50);
    for (const secret of secrets) {
      expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    }
  });

  it('round-trips a secret without storing it in the clear', () => {
    const cipher = new WebhookSecretCipher(KEY);
    const secret = generateWebhookSecret();

    const sealed = cipher.encrypt(secret, MERCHANT);

    expect(Buffer.from(sealed).toString('latin1')).not.toContain(secret);
    expect(cipher.decrypt(sealed, MERCHANT)).toBe(secret);
    expect(Buffer.from(cipher.encrypt(secret, MERCHANT))).not.toEqual(
      Buffer.from(sealed),
    );
  });

  it('refuses a ciphertext moved to another merchant, altered, or sealed under another key', () => {
    const cipher = new WebhookSecretCipher(KEY);
    const sealed = cipher.encrypt(generateWebhookSecret(), MERCHANT);
    const altered = Buffer.from(sealed);
    altered[altered.length - 1] ^= 0x01;

    expect(() => cipher.decrypt(sealed, OTHER_MERCHANT)).toThrow();
    expect(() => cipher.decrypt(altered, MERCHANT)).toThrow();
    expect(() =>
      new WebhookSecretCipher('11'.repeat(32)).decrypt(sealed, MERCHANT),
    ).toThrow();
    expect(() => cipher.decrypt(Buffer.from([2, 0, 0]), MERCHANT)).toThrow(
      /Unrecognised/,
    );
  });

  it('requires a 32-byte key', () => {
    expect(() => new WebhookSecretCipher('7e'.repeat(16))).toThrow(/32 bytes/);
  });
});
