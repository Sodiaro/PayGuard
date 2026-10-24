import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { MerchantsService } from '../../src/merchants/merchants.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../../src/payments/providers/payment-provider.js';

export interface TestAppOptions {
  logger?: LoggerService | false;
  // Test-only replacement for the configured simulator.
  provider?: PaymentProvider;
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.provider) {
    builder = builder
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(options.provider);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: options.logger ?? false,
  });
  configureApp(app);
  await app.init();
  return app;
}

export function prismaOf(app: INestApplication): PrismaService {
  return app.get(PrismaService);
}

export async function provisionMerchant(
  app: INestApplication,
  slug: string,
): Promise<{ merchantId: string; apiKeyId: string; apiKey: string }> {
  const { merchant, apiKey } = await app
    .get(MerchantsService)
    .provision({ name: `Merchant ${slug}`, slug });
  return {
    merchantId: merchant.id,
    apiKeyId: apiKey.id,
    apiKey: apiKey.plaintext,
  };
}
