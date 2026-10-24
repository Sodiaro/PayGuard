import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';
import { MerchantsController } from './merchants.controller.js';
import { MerchantsService } from './merchants.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [MerchantsController, ApiKeysController],
  providers: [MerchantsService, ApiKeysService],
  exports: [MerchantsService, ApiKeysService],
})
export class MerchantsModule {}
