import { describe, expect, it } from '@jest/globals';
import { clientRateLimitKey } from './client-key.js';

describe('clientRateLimitKey', () => {
  it('keys IPv4 clients by address', () => {
    expect(clientRateLimitKey('203.0.113.7')).toBe('ip:203.0.113.7');
  });

  it('treats IPv4-mapped IPv6 as the IPv4 address', () => {
    expect(clientRateLimitKey('::ffff:203.0.113.7')).toBe('ip:203.0.113.7');
  });

  it.each([
    ['2001:db8:85a3:12::1', '2001:db8:85a3:12'],
    ['2001:db8:85a3:12:ffff:ffff:ffff:fffe', '2001:db8:85a3:12'],
    ['2001:0db8:85a3:0012:0000:0000:0000:0001', '2001:db8:85a3:12'],
    ['2001:db8::1', '2001:db8:0:0'],
    ['::1', '0:0:0:0'],
    ['fe80::1%eth0', 'fe80:0:0:0'],
  ])('keys IPv6 %s by its /64', (ip, prefix) => {
    expect(clientRateLimitKey(ip)).toBe(`ip6:${prefix}::/64`);
  });

  it('gives every address inside one /64 the same bucket', () => {
    const keys = new Set(
      Array.from({ length: 50 }, (_, i) =>
        clientRateLimitKey(`2001:db8:1:2:${i.toString(16)}::${i}`),
      ),
    );
    expect(keys).toEqual(new Set(['ip6:2001:db8:1:2::/64']));
  });

  it('falls back to a shared key when the address is unknown', () => {
    expect(clientRateLimitKey(undefined)).toBe('ip:unknown');
  });
});
