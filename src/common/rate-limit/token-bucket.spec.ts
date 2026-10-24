import { describe, expect, it } from '@jest/globals';
import { TokenBucketLimiter } from './token-bucket.js';

function limiterAt(limitPerMinute: number) {
  let now = 1_000_000;
  const limiter = TokenBucketLimiter.perMinute(limitPerMinute, () => now);
  return {
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('TokenBucketLimiter', () => {
  it('allows a burst up to the limit, then refuses with a retry hint', () => {
    const { limiter } = limiterAt(3);

    expect([1, 2, 3].map(() => limiter.consume('a').allowed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.consume('a')).toEqual({
      allowed: false,
      retryAfterSeconds: 20,
    });
  });

  it('refills over time', () => {
    const { limiter, advance } = limiterAt(60);
    for (let i = 0; i < 60; i++) limiter.consume('a');

    expect(limiter.consume('a').allowed).toBe(false);
    advance(999);
    expect(limiter.consume('a').allowed).toBe(false);
    advance(1);
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('keeps keys independent', () => {
    const { limiter } = limiterAt(1);

    expect(limiter.consume('merchant:a').allowed).toBe(true);
    expect(limiter.consume('merchant:a').allowed).toBe(false);
    expect(limiter.consume('merchant:b').allowed).toBe(true);
  });

  it('does not let refused requests extend the wait indefinitely', () => {
    const { limiter, advance } = limiterAt(1);
    limiter.consume('a');
    for (let i = 0; i < 10; i++) limiter.consume('a');

    advance(60_000);
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('forgets idle keys once their bucket is full again', () => {
    const { limiter, advance } = limiterAt(10);
    limiter.consume('a');
    limiter.consume('b');
    expect(limiter.trackedKeys).toBe(2);

    advance(120_000);
    limiter.consume('c');
    expect(limiter.trackedKeys).toBe(1);
  });
});
