import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { MerchantsService } from '../../src/merchants/merchants.service.js';

export async function createTestApp(
  logger: LoggerService | false = false,
): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger,
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
