import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

// Supertest connects over loopback, so trusting "loopback" makes the test client a proxy.
process.env.TRUSTED_PROXIES = 'loopback';
process.env.RATE_LIMIT_IP_PER_MINUTE = '2';
const { createTestApp } = await import('./support/test-app.js');

describe('Rate limiting behind a trusted proxy', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const fromClient = (forwardedFor: string) =>
    request(app.getHttpServer())
      .get('/v1/merchants/me')
      .set('X-Forwarded-For', forwardedFor);

  it('limits each forwarded client separately', async () => {
    const first = [];
    for (let i = 0; i < 3; i++)
      first.push((await fromClient('203.0.113.1')).status);
    const other = (await fromClient('203.0.113.2')).status;

    expect(first).toEqual([401, 401, 429]);
    expect(other).toBe(401);
  });

  it('groups IPv6 clients by /64 so address rotation does not escape the limit', async () => {
    const statuses = [];
    for (let i = 1; i <= 3; i++) {
      statuses.push((await fromClient(`2001:db8:aa:bb::${i}`)).status);
    }

    expect(statuses).toEqual([401, 401, 429]);
    expect((await fromClient('2001:db8:aa:cc::1')).status).toBe(401);
  });

  it('uses the address added by the trusted proxy, not a value the client prepended', async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await fromClient(`10.9.9.${i}, 203.0.113.50`)).status);
    }

    expect(statuses).toEqual([401, 401, 429]);
  });
});
