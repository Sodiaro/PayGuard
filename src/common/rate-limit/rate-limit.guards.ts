import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/authenticated-merchant.js';
import type { TokenBucketLimiter } from './token-bucket.js';

export const IP_RATE_LIMITER = Symbol('IP_RATE_LIMITER');
export const PAYMENT_CREATION_RATE_LIMITER = Symbol(
  'PAYMENT_CREATION_RATE_LIMITER',
);

const SKIP_RATE_LIMIT = 'payguard:skipRateLimit';

// For infrastructure probes only (health checks), which must keep answering under load.
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);

export class RateLimitExceededException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      `Rate limit exceeded; retry after ${retryAfterSeconds} seconds`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

function enforce(
  limiter: TokenBucketLimiter,
  key: string,
  context: ExecutionContext,
): void {
  const decision = limiter.consume(key);
  if (!decision.allowed) {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(decision.retryAfterSeconds));
    throw new RateLimitExceededException(decision.retryAfterSeconds);
  }
}

// Global, and registered before the API-key guard: it bounds the database lookups an anonymous
// client can cause with invalid keys. Behind a proxy, request.ip is only the client's address if
// TRUST_PROXY_HOPS is set correctly.
@Injectable()
export class IpRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(IP_RATE_LIMITER) private readonly limiter: TokenBucketLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(
      SKIP_RATE_LIMIT,
      [context.getHandler(), context.getClass()],
    );
    if (!skip) {
      const ip = context.switchToHttp().getRequest<AuthenticatedRequest>().ip;
      enforce(this.limiter, `ip:${ip ?? 'unknown'}`, context);
    }
    return true;
  }
}

// Route-level, so it runs after authentication and limits per merchant rather than per IP.
@Injectable()
export class PaymentCreationRateLimitGuard implements CanActivate {
  constructor(
    @Inject(PAYMENT_CREATION_RATE_LIMITER)
    private readonly limiter: TokenBucketLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const merchant = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().merchant;
    if (!merchant) {
      throw new Error(
        'PaymentCreationRateLimitGuard requires API-key authentication',
      );
    }
    enforce(this.limiter, `merchant:${merchant.merchantId}`, context);
    return true;
  }
}
