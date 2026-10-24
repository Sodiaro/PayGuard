import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

// Configuration is validated when the app module is first imported, so the variable is set
// before a dynamic import. Jest gives each test file its own module registry.
process.env.CORS_ALLOWED_ORIGINS = 'https://dashboard.example.com';
const { createTestApp } = await import('./support/test-app.js');

describe('CORS with an explicit allowlist', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows a listed origin, including preflight for Authorization', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/v1/merchants/me')
      .set('Origin', 'https://dashboard.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization')
      .expect(204);

    expect(preflight.headers).toMatchObject({
      'access-control-allow-origin': 'https://dashboard.example.com',
      'access-control-allow-headers': expect.stringContaining('Authorization'),
    });
    expect(preflight.headers).not.toHaveProperty(
      'access-control-allow-credentials',
    );
  });

  it('does not allow other origins', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/live')
      .set('Origin', 'https://evil.example');

    expect(response.headers).not.toHaveProperty('access-control-allow-origin');
  });
});
