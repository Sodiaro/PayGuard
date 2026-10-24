import { describe, expect, it } from '@jest/globals';
import {
  generateApiKey,
  hashSecret,
  parseApiKey,
  secretMatches,
} from './api-key.js';

describe('API key format', () => {
  it('generates keys in the documented format', () => {
    const key = generateApiKey();

    expect(/^pgsk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(key.plaintext)).toBe(
      true,
    );
    expect(key.plaintext.startsWith(`pgsk_${key.prefix}_`)).toBe(true);
    expect(key.secretHash).toHaveLength(32);
  });

  it('never repeats prefixes or secrets', () => {
    const keys = Array.from({ length: 200 }, () => generateApiKey());

    expect(new Set(keys.map((key) => key.prefix)).size).toBe(200);
    expect(new Set(keys.map((key) => key.plaintext)).size).toBe(200);
  });

  it('round-trips through parse and hash', () => {
    const key = generateApiKey();
    const parsed = parseApiKey(key.plaintext);

    expect(parsed?.prefix).toBe(key.prefix);
    expect(Buffer.from(hashSecret(parsed!.secret)).equals(key.secretHash)).toBe(
      true,
    );
  });

  it.each([
    ['empty', ''],
    ['prefix only', 'pgsk_0123456789abcdef_'],
    ['foreign prefix', 'sk_live_0123456789abcdef_' + 'a'.repeat(43)],
    ['uppercase lookup prefix', 'pgsk_0123456789ABCDEF_' + 'a'.repeat(43)],
    ['short secret', 'pgsk_0123456789abcdef_' + 'a'.repeat(42)],
    ['long secret', 'pgsk_0123456789abcdef_' + 'a'.repeat(44)],
    ['trailing whitespace', 'pgsk_0123456789abcdef_' + 'a'.repeat(43) + ' '],
    ['embedded newline', 'pgsk_0123456789abcdef_' + 'a'.repeat(42) + '\n'],
  ])('rejects a malformed key (%s)', (_case, candidate) => {
    expect(parseApiKey(candidate)).toBeNull();
  });
});

describe('secretMatches', () => {
  const key = generateApiKey();
  const { secret } = parseApiKey(key.plaintext)!;

  it('accepts the issued secret', () => {
    expect(secretMatches(secret, key.secretHash)).toBe(true);
  });

  it('rejects a secret that differs by one character', () => {
    const altered = (secret[0] === 'A' ? 'B' : 'A') + secret.slice(1);
    expect(secretMatches(altered, key.secretHash)).toBe(false);
  });

  it('rejects a stored hash of the wrong length instead of throwing', () => {
    expect(secretMatches(secret, new Uint8Array(16))).toBe(false);
  });
});
