import { describe, expect, it } from '@jest/globals';
import { InvalidMerchantInputError } from './merchant-errors.js';
import {
  normalizeMerchantName,
  slugFromName,
  validateKeyExpiry,
  validateKeyLabel,
  validateSlug,
} from './merchant-input.js';

describe('merchant input', () => {
  it.each([
    ['Acme Ltd.', 'acme-ltd'],
    ['  Café   Ünïcode & Co ', 'cafe-unicode-co'],
    ['---', ''],
    ['a'.repeat(63) + ' b', 'a'.repeat(63)],
  ])('derives slug from %j', (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });

  it.each(['ab', 'Acme', 'acme--ltd', '-acme', 'acme_ltd', 'a'.repeat(65)])(
    'rejects slug %j',
    (slug) => {
      expect(() => validateSlug(slug)).toThrow(InvalidMerchantInputError);
    },
  );

  it('normalizes whitespace in names and rejects empty ones', () => {
    expect(normalizeMerchantName('  Acme \n  Ltd ')).toBe('Acme Ltd');
    expect(() => normalizeMerchantName('   ')).toThrow(
      InvalidMerchantInputError,
    );
  });

  it('accepts only future, valid expiry dates', () => {
    const future = new Date(Date.now() + 60_000);

    expect(validateKeyExpiry(undefined)).toBeNull();
    expect(validateKeyExpiry(future)).toBe(future);
    expect(() => validateKeyExpiry(new Date(Date.now() - 1))).toThrow(
      InvalidMerchantInputError,
    );
    expect(() => validateKeyExpiry(new Date('not a date'))).toThrow(
      InvalidMerchantInputError,
    );
  });

  it('trims labels and bounds their length', () => {
    expect(validateKeyLabel(undefined)).toBeNull();
    expect(validateKeyLabel(' production ')).toBe('production');
    expect(() => validateKeyLabel('x'.repeat(101))).toThrow(
      InvalidMerchantInputError,
    );
  });
});
