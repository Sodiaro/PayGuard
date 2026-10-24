import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { AppConfigModule } from './config/app-config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { MerchantsModule } from './merchants/merchants.module.js';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AuthModule,
    HealthModule,
    MerchantsModule,
  ],
})
export class AppModule {}
