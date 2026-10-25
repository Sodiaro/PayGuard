import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module.js';
import { ApiKeyAuthenticator } from './api-key-authenticator.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { KeyUsageTracker } from './key-usage-tracker.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    ApiKeyAuthenticator,
    KeyUsageTracker,
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
  exports: [ApiKeyAuthenticator],
})
export class AuthModule {}
