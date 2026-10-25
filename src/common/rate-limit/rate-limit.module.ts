import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { ApiEnvironment } from '../../config/environment.js';
import {
  IP_RATE_LIMITER,
  IpRateLimitGuard,
  PAYMENT_CREATION_RATE_LIMITER,
  PaymentCreationRateLimitGuard,
} from './rate-limit.guards.js';
import { TokenBucketLimiter } from './token-bucket.js';

type Config = ConfigService<ApiEnvironment, true>;

@Module({
  providers: [
    {
      provide: IP_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        TokenBucketLimiter.perMinute(
          config.get('RATE_LIMIT_IP_PER_MINUTE', { infer: true }),
        ),
    },
    {
      provide: PAYMENT_CREATION_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        TokenBucketLimiter.perMinute(
          config.get('RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE', { infer: true }),
        ),
    },
    { provide: APP_GUARD, useClass: IpRateLimitGuard },
    PaymentCreationRateLimitGuard,
  ],
  exports: [PAYMENT_CREATION_RATE_LIMITER, PaymentCreationRateLimitGuard],
})
export class RateLimitModule {}
