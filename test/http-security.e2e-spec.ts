import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './support/test-app.js';

describe('HTTP security headers and default CORS policy', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets Helmet headers and hides the framework', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);

    expect(response.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'strict-transport-security': expect.stringContaining('max-age='),
      'content-security-policy': expect.stringContaining("default-src 'self'"),
    });
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  it('sends no CORS headers when no origins are configured', async () => {
    const simple = await request(app.getHttpServer())
      .get('/health/live')
      .set('Origin', 'https://evil.example');
    const preflight = await request(app.getHttpServer())
      .options('/v1/merchants/me')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');

    expect(simple.headers).not.toHaveProperty('access-control-allow-origin');
    expect(preflight.headers).not.toHaveProperty('access-control-allow-origin');
  });
});
