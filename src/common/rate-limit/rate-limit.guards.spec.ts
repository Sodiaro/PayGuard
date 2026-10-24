import { describe, expect, it } from '@jest/globals';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IpRateLimitGuard,
  PaymentCreationRateLimitGuard,
  RateLimitExceededException,
} from './rate-limit.guards.js';
import { TokenBucketLimiter } from './token-bucket.js';

function contextFor(request: object) {
  const headers: Record<string, string> = {};
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

const reflector = (skip: boolean) =>
  ({ getAllAndOverride: () => skip }) as unknown as Reflector;

describe('IpRateLimitGuard', () => {
  it('limits per client IP and sets Retry-After', () => {
    const guard = new IpRateLimitGuard(
      reflector(false),
      TokenBucketLimiter.perMinute(1),
    );
    const first = contextFor({ ip: '203.0.113.7' });
    const second = contextFor({ ip: '203.0.113.7' });

    expect(guard.canActivate(first.context)).toBe(true);
    expect(() => guard.canActivate(second.context)).toThrow(
      RateLimitExceededException,
    );
    expect(second.headers['Retry-After']).toBe('60');
    expect(guard.canActivate(contextFor({ ip: '198.51.100.1' }).context)).toBe(
      true,
    );
  });

  it('skips routes marked @SkipRateLimit()', () => {
    const guard = new IpRateLimitGuard(
      reflector(true),
      TokenBucketLimiter.perMinute(1),
    );
    for (let i = 0; i < 5; i++) {
      expect(guard.canActivate(contextFor({ ip: '203.0.113.7' }).context)).toBe(
        true,
      );
    }
  });
});

describe('PaymentCreationRateLimitGuard', () => {
  it('limits per authenticated merchant, not per IP', () => {
    const guard = new PaymentCreationRateLimitGuard(
      TokenBucketLimiter.perMinute(1),
    );
    const asMerchant = (merchantId: string, ip: string) =>
      contextFor({ ip, merchant: { merchantId, apiKeyId: 'k' } }).context;

    expect(guard.canActivate(asMerchant('m-1', '203.0.113.7'))).toBe(true);
    expect(() => guard.canActivate(asMerchant('m-1', '198.51.100.1'))).toThrow(
      RateLimitExceededException,
    );
    expect(guard.canActivate(asMerchant('m-2', '203.0.113.7'))).toBe(true);
  });

  it('refuses to run on an unauthenticated route', () => {
    const guard = new PaymentCreationRateLimitGuard(
      TokenBucketLimiter.perMinute(1),
    );
    expect(() =>
      guard.canActivate(contextFor({ ip: '203.0.113.7' }).context),
    ).toThrow(/requires API-key authentication/);
  });
});
