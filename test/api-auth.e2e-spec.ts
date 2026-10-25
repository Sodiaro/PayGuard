import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { parseApiKey } from '../src/auth/api-key.js';
import { AppLogger } from '../src/common/logging/app-logger.js';
import type { ErrorResponse } from '../src/common/http/error-response.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import { MerchantStatus } from '../src/generated/prisma/enums.js';
import { ApiKeysService } from '../src/merchants/api-keys.service.js';
import { MerchantsService } from '../src/merchants/merchants.service.js';
import {
  createTestApp,
  prismaOf,
  provisionMerchant,
} from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';

type Merchant = Awaited<ReturnType<typeof provisionMerchant>>;

describe('API-key authentication over HTTP (PostgreSQL)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let acme: Merchant;
  let globex: Merchant;
  let logOutput: string[];

  beforeAll(async () => {
    app = await createTestApp({ logger: new AppLogger({ json: true }) });
    prisma = prismaOf(app);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    acme = await provisionMerchant(app, 'acme');
    globex = await provisionMerchant(app, 'globex');

    logOutput = [];
    const capture = (chunk: string | Uint8Array) => {
      logOutput.push(String(chunk));
      return true;
    };
    jest.spyOn(process.stdout, 'write').mockImplementation(capture);
    jest.spyOn(process.stderr, 'write').mockImplementation(capture);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const withKey = (path: string, key: string) =>
    http().get(path).set('Authorization', `Bearer ${key}`);

  describe('rejections', () => {
    it('requires credentials on business routes', async () => {
      const response = await http().get('/v1/merchants/me').expect(401);

      expect(response.body).toMatchObject({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Missing API key',
        path: '/v1/merchants/me',
      });
      expect(response.headers['www-authenticate']).toBe(
        'Bearer realm="PayGuard"',
      );
    });

    it('does not accept a key passed in the query string', async () => {
      const response = await http()
        .get(`/v1/merchants/me?api_key=${acme.apiKey}`)
        .expect(401);

      expect((response.body as ErrorResponse).message).toBe('Missing API key');
      expect((response.body as ErrorResponse).path).toBe('/v1/merchants/me');
    });

    it('answers every invalid credential identically', async () => {
      const revoked = await app.get(MerchantsService).issueKey('globex', {});
      await app.get(ApiKeysService).revoke(revoked.apiKey.id);

      const expiring = await app
        .get(MerchantsService)
        .issueKey('globex', { expiresAt: new Date(Date.now() + 60_000) });
      await prisma.merchantApiKey.update({
        where: { id: expiring.apiKey.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const suspended = await provisionMerchant(app, 'initech');
      await app
        .get(MerchantsService)
        .setStatus('initech', MerchantStatus.SUSPENDED);

      const { prefix, secret } = parseApiKey(acme.apiKey)!;
      const credentials = {
        malformed: 'definitely-not-a-key',
        unknownPrefix: `pgsk_0123456789abcdef_${secret}`,
        wrongSecret: `pgsk_${prefix}_${'A'.repeat(43)}`,
        revoked: revoked.apiKey.plaintext,
        expired: expiring.apiKey.plaintext,
        suspendedMerchant: suspended.apiKey,
      };

      for (const [name, credential] of Object.entries(credentials)) {
        const response = await withKey('/v1/merchants/me', credential);
        const body = response.body as ErrorResponse;
        expect({
          name,
          status: response.status,
          message: body.message,
        }).toEqual({
          name,
          status: 401,
          message: 'Invalid API key',
        });
        expect(response.headers['www-authenticate']).toContain(
          'error="invalid_token"',
        );
      }
    });

    it('rejects non-Bearer authorization schemes', async () => {
      await http()
        .get('/v1/merchants/me')
        .set(
          'Authorization',
          `Basic ${Buffer.from(`x:${acme.apiKey}`).toString('base64')}`,
        )
        .expect(401);
    });
  });

  describe('merchant context', () => {
    it('identifies the merchant from the key alone', async () => {
      const response = await withKey('/v1/merchants/me', acme.apiKey).expect(
        200,
      );

      expect(response.body).toEqual({
        id: acme.merchantId,
        slug: 'acme',
        name: 'Merchant acme',
        status: 'ACTIVE',
        createdAt: expect.any(String),
      });
    });

    it('ignores merchant identifiers supplied by the client', async () => {
      const response = await http()
        .get(`/v1/merchants/me?merchantId=${globex.merchantId}`)
        .set('Authorization', `Bearer ${acme.apiKey}`)
        .set('X-Merchant-Id', globex.merchantId)
        .expect(200);

      expect((response.body as { id: string }).id).toBe(acme.merchantId);
    });

    it("lists only the caller's keys, without secrets", async () => {
      const response = await withKey('/v1/api-keys', acme.apiKey).expect(200);
      const keys = response.body as Record<string, unknown>[];

      expect(keys.map((key) => key.id)).toEqual([acme.apiKeyId]);
      expect(Object.keys(keys[0]).sort()).toEqual(
        [
          'createdAt',
          'lastUsedAt',
          'expiresAt',
          'id',
          'label',
          'prefix',
          'revokedAt',
          'status',
        ].sort(),
      );
      expect(
        JSON.stringify(keys).includes(parseApiKey(acme.apiKey)!.secret),
      ).toBe(false);
    });

    it("cannot read another merchant's key, which looks like it does not exist", async () => {
      const foreign = await withKey(
        `/v1/api-keys/${globex.apiKeyId}`,
        acme.apiKey,
      ).expect(404);
      const missing = await withKey(
        '/v1/api-keys/01890000-0000-7000-8000-000000000000',
        acme.apiKey,
      ).expect(404);

      expect((foreign.body as ErrorResponse).message).toBe(
        (missing.body as ErrorResponse).message,
      );
      await withKey(`/v1/api-keys/${acme.apiKeyId}`, acme.apiKey).expect(200);
    });

    it('validates path parameters after authentication', async () => {
      await withKey('/v1/api-keys/not-a-uuid', acme.apiKey).expect(400);
    });
  });

  describe('public routes', () => {
    it('keeps health checks open', async () => {
      await http().get('/health').expect(200);
      await http().get('/health/live').expect(200);
    });
  });

  describe('credential hygiene', () => {
    it('never writes keys to logs or responses, while still logging rejections', async () => {
      const { prefix, secret } = parseApiKey(acme.apiKey)!;
      const responses = [
        await withKey('/v1/merchants/me', acme.apiKey),
        await withKey('/v1/merchants/me', `pgsk_${prefix}_${'B'.repeat(43)}`),
        await http().get(`/v1/merchants/me?api_key=${acme.apiKey}`),
        await withKey('/v1/does-not-exist', acme.apiKey),
      ];
      const secrets = [acme.apiKey, secret, 'B'.repeat(43)];

      const everything = [
        ...logOutput,
        ...responses.map(
          (response) => JSON.stringify(response.headers) + response.text,
        ),
      ].join('\n');
      expect(secrets.some((secret) => everything.includes(secret))).toBe(false);

      const records = logOutput.map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          message: 'API key rejected',
          reason: 'invalid_secret',
          keyPrefix: prefix,
          requestId: expect.any(String),
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          message: 'Request completed',
          path: '/v1/merchants/me',
          statusCode: 200,
          merchantId: acme.merchantId,
        }),
      );
    });
  });
});
