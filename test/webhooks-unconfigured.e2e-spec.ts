import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';

// Empty counts as unset, and wins over any secret in .env.
process.env.SIMULATOR_WEBHOOK_SECRET = '';
const { createTestApp, prismaOf } = await import('./support/test-app.js');
const { resetDatabase } = await import('./support/test-database.js');
const { webhooksApi } = await import('./support/webhooks.js');

describe('Provider webhooks without a configured secret', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(prismaOf(app));
  });

  afterAll(async () => {
    await app.close();
  });

  const event = {
    id: 'evt_0123456789abcdef01234567',
    type: 'payment.succeeded' as const,
    createdAt: new Date().toISOString(),
    data: {
      attemptId: '019a0000-0000-7000-8000-000000000000',
      providerReference: 'sim_0123456789abcdef01234567',
      amount: 500000,
      currency: 'NGN' as const,
    },
  };

  it.each([
    [
      'signed with any secret',
      { secret: 'some-secret-the-sender-chose-0123456789' },
    ],
    ['unsigned', { signature: null }],
  ])('rejects every delivery, %s, as unavailable', async (_case, options) => {
    const response = await webhooksApi(app).deliver(event, options).expect(503);

    expect(response.body).toMatchObject({
      message: 'Webhooks are not configured',
    });
    await expect(prismaOf(app).providerWebhookEvent.count()).resolves.toBe(0);
  });
});
