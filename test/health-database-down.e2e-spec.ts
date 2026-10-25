import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

// Nothing listens on port 1. The database name still ends in _test, so the test-database
// safeguards apply; connections open lazily, so the app starts while the database is unreachable.
process.env.DATABASE_URL =
  'postgresql://payguard:unused-password@127.0.0.1:1/unreachable_test';
const { createTestApp } = await import('./support/test-app.js');

describe('Health while PostgreSQL is unreachable', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('fails readiness with 503 and a generic reason', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(503);

    expect(response.body).toMatchObject({
      status: 'error',
      details: {
        database: { status: 'down', message: 'Database is unreachable' },
        queue: { status: 'degraded', reasons: ['unavailable'] },
        workers: { status: 'degraded', reasons: ['unavailable'] },
      },
    });
    expect(response.text).not.toMatch(
      /unused-password|ECONNREFUSED|127\.0\.0\.1/,
    );
  });

  it('keeps liveness green so the process is not restarted for a database outage', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});
