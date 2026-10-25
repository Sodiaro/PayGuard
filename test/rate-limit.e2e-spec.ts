import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { ErrorResponse } from '../src/common/http/error-response.js';

// Limits are read when configuration is first loaded, so they are set before importing the app.
process.env.RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE = '2';
process.env.RATE_LIMIT_IP_PER_MINUTE = '15';
const { createTestApp, prismaOf, provisionMerchant } =
  await import('./support/test-app.js');
const { resetDatabase } = await import('./support/test-database.js');

describe('Rate limiting', () => {
  let app: INestApplication<App>;

  // A fresh app per test gives fresh in-memory limiters.
  beforeEach(async () => {
    app = await createTestApp();
    await resetDatabase(prismaOf(app));
  });

  afterEach(async () => {
    await app.close();
  });

  const createPayment = (apiKey: string, idempotencyKey: string) =>
    request(app.getHttpServer())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ amount: 1000, currency: 'USD' });

  it('limits payment creation per merchant with a documented 429', async () => {
    const acme = await provisionMerchant(app, 'acme');
    const globex = await provisionMerchant(app, 'globex');

    await createPayment(acme.apiKey, 'k1').expect(202);
    await createPayment(acme.apiKey, 'k2').expect(202);
    const limited = await createPayment(acme.apiKey, 'k3').expect(429);

    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({
      statusCode: 429,
      error: 'Too Many Requests',
      message: expect.stringMatching(
        /^Rate limit exceeded; retry after \d+ seconds$/,
      ),
      path: '/v1/payments',
      requestId: expect.any(String),
    });
    await expect(prismaOf(app).payment.count()).resolves.toBe(2);

    await createPayment(globex.apiKey, 'k3').expect(202);
    await request(app.getHttpServer())
      .get('/v1/merchants/me')
      .set('Authorization', `Bearer ${acme.apiKey}`)
      .expect(200);
  });

  it('limits by IP before authentication, but never health checks', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 16; i++) {
      const response = await request(app.getHttpServer()).get(
        '/v1/merchants/me',
      );
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 15).every((status) => status === 401)).toBe(true);
    expect(statuses[15]).toBe(429);

    const blocked = await request(app.getHttpServer())
      .get('/v1/merchants/me')
      .set('Authorization', 'Bearer pgsk_0123456789abcdef_' + 'a'.repeat(43))
      .expect(429);
    expect((blocked.body as ErrorResponse).message).toContain(
      'Rate limit exceeded',
    );

    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
