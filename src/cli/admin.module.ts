import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module.js';
import { MerchantsModule } from '../merchants/merchants.module.js';

@Module({
  imports: [AppConfigModule, MerchantsModule],
})
export class AdminModule {}
