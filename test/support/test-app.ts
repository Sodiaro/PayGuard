import type {
  INestApplication,
  INestApplicationContext,
  LoggerService,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AdminModule } from '../../src/cli/admin.module.js';
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

const operators = new WeakMap<INestApplication, INestApplicationContext>();

// The API under test connects as the application's runtime role. Alongside it runs the operator
// CLI's context, connected as the operator role, for what only operators may do: provisioning
// merchants and keys, requeueing, pruning. It is closed with the app.
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<INestApplication<App>> {
  // Built first: Nest's logger is process-wide, and the app's (possibly capturing) logger must be
  // the one set last.
  const operator = await Test.createTestingModule({
    imports: [AdminModule],
  }).compile();
  await operator.init();

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

  operators.set(app, operator);
  const closeApp = app.close.bind(app);
  app.close = async () => {
    await operator.close();
    await closeApp();
  };
  return app;
}

export function prismaOf(app: INestApplication): PrismaService {
  return app.get(PrismaService);
}

export function operatorOf(app: INestApplication): INestApplicationContext {
  const operator = operators.get(app);
  if (!operator) throw new Error('The app was not created by createTestApp');
  return operator;
}

export async function provisionMerchant(
  app: INestApplication,
  slug: string,
): Promise<{ merchantId: string; apiKeyId: string; apiKey: string }> {
  const { merchant, apiKey } = await operatorOf(app)
    .get(MerchantsService)
    .provision({ name: `Merchant ${slug}`, slug });
  return {
    merchantId: merchant.id,
    apiKeyId: apiKey.id,
    apiKey: apiKey.plaintext,
  };
}
