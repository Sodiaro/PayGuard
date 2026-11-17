import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

// Empty counts as unset.
process.env.MERCHANT_WEBHOOK_ENCRYPTION_KEY = '';
const { createTestApp, prismaOf, provisionMerchant } =
  await import('./support/test-app.js');
const { resetDatabase } = await import('./support/test-database.js');

describe('Merchant webhooks without an encryption key', () => {
  let app: INestApplication<App>;
  let apiKey: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    apiKey = (await provisionMerchant(app, 'acme')).apiKey;
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses to configure an endpoint, since its secret could not be stored', async () => {
    const response = await request(app.getHttpServer())
      .put('/v1/webhook-endpoint')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ url: 'http://127.0.0.1:9/hook' })
      .expect(503);

    expect(response.body).toMatchObject({
      message: 'Merchant webhooks are not configured',
    });
    await request(app.getHttpServer())
      .post('/v1/webhook-endpoint/rotate-secret')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(503);
    await expect(prismaOf(app).merchantWebhookEndpoint.count()).resolves.toBe(
      0,
    );
  });
});
