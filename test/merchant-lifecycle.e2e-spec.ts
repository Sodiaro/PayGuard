import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { parseApiKey } from '../src/auth/api-key.js';
import { ApiKeyAuthenticator } from '../src/auth/api-key-authenticator.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { MerchantStatus } from '../src/generated/prisma/enums.js';
import { ApiKeysService } from '../src/merchants/api-keys.service.js';
import {
  ApiKeyNotFoundError,
  InvalidMerchantInputError,
  MerchantAlreadyExistsError,
} from '../src/merchants/merchant-errors.js';
import { MerchantsService } from '../src/merchants/merchants.service.js';
import { createTestApp, operatorOf, prismaOf } from './support/test-app.js';
import { ownerDatabase, resetDatabase } from './support/test-database.js';

describe('Merchant lifecycle and API keys (PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let merchants: MerchantsService;
  let apiKeys: ApiKeysService;
  let authenticator: ApiKeyAuthenticator;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = prismaOf(app);
    // Provisioning and revocation are operator actions, so they run with the operator role.
    merchants = operatorOf(app).get(MerchantsService);
    apiKeys = operatorOf(app).get(ApiKeysService);
    authenticator = app.get(ApiKeyAuthenticator);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  const counts = async () => ({
    merchants: await prisma.merchant.count(),
    keys: await prisma.merchantApiKey.count(),
  });

  describe('provisioning', () => {
    it('creates an active merchant whose first key authenticates', async () => {
      const { merchant, apiKey } = await merchants.provision({
        name: '  Acme   Ltd ',
        firstKey: { label: 'production' },
      });

      expect(merchant).toMatchObject({
        slug: 'acme-ltd',
        name: 'Acme Ltd',
        status: MerchantStatus.ACTIVE,
      });
      expect(apiKey).toMatchObject({ label: 'production', status: 'active' });
      await expect(
        authenticator.authenticate(apiKey.plaintext),
      ).resolves.toEqual({
        authenticated: true,
        merchant: { merchantId: merchant.id, apiKeyId: apiKey.id },
      });
    });

    it('persists only the lookup prefix and a SHA-256 digest of the secret', async () => {
      const { apiKey } = await merchants.provision({ name: 'Acme' });
      const { prefix, secret } = parseApiKey(apiKey.plaintext)!;

      const [row] = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM merchant_api_keys`;
      const stored = row.secret_hash as Uint8Array;
      const everyColumn = JSON.stringify(row, (_key, value: unknown) =>
        value instanceof Uint8Array
          ? Buffer.from(value).toString('hex')
          : value,
      );

      expect(row.prefix).toBe(prefix);
      expect(
        Buffer.from(stored).equals(
          createHash('sha256').update(secret).digest(),
        ),
      ).toBe(true);
      expect(everyColumn.includes(secret)).toBe(false);
      expect(everyColumn.includes(apiKey.plaintext)).toBe(false);
    });

    it('is enforced by the database: secret_hash cannot hold key material', async () => {
      const { merchant } = await merchants.provision({ name: 'Acme' });

      await expect(
        operatorOf(app).get(PrismaService).$executeRaw`
          INSERT INTO merchant_api_keys (id, merchant_id, prefix, secret_hash)
          VALUES (gen_random_uuid(), ${merchant.id}::uuid, 'feedfacecafebeef',
                  convert_to('pgsk_feedfacecafebeef_plaintext-secret', 'UTF8'))`,
      ).rejects.toThrow(/secret_hash_length/);
    });

    it('rejects a retry instead of creating a duplicate merchant or key', async () => {
      await merchants.provision({ name: 'Acme Ltd' });

      await expect(
        merchants.provision({ name: 'Acme Ltd' }),
      ).rejects.toBeInstanceOf(MerchantAlreadyExistsError);
      await expect(counts()).resolves.toEqual({ merchants: 1, keys: 1 });
    });

    it('lets exactly one of several concurrent provisioning attempts win', async () => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          merchants.provision({ name: 'Racing Merchant' }),
        ),
      );

      const fulfilled = attempts.filter(
        (attempt) => attempt.status === 'fulfilled',
      );
      const rejected = attempts.filter(
        (attempt): attempt is PromiseRejectedResult =>
          attempt.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(
        rejected.every(
          (attempt) => attempt.reason instanceof MerchantAlreadyExistsError,
        ),
      ).toBe(true);
      await expect(counts()).resolves.toEqual({ merchants: 1, keys: 1 });
    });

    it('writes nothing when input is invalid', async () => {
      await expect(
        merchants.provision({ name: 'Acme', slug: 'Not A Slug' }),
      ).rejects.toBeInstanceOf(InvalidMerchantInputError);
      await expect(
        merchants.provision({
          name: 'Acme',
          firstKey: { expiresAt: new Date(Date.now() - 1000) },
        }),
      ).rejects.toBeInstanceOf(InvalidMerchantInputError);
      await expect(counts()).resolves.toEqual({ merchants: 0, keys: 0 });
    });
  });

  describe('keys', () => {
    it('supports several independent keys per merchant', async () => {
      const { merchant, apiKey: first } = await merchants.provision({
        name: 'Acme',
      });
      const { apiKey: second } = await merchants.issueKey('acme', {
        label: 'ci',
      });
      const { apiKey: third } = await merchants.issueKey(merchant.id, {});

      const listed = await apiKeys.listForMerchant(merchant.id);
      expect(listed.map((key) => key.id)).toEqual([
        first.id,
        second.id,
        third.id,
      ]);

      for (const key of [first, second, third]) {
        await expect(
          authenticator.authenticate(key.plaintext),
        ).resolves.toEqual({
          authenticated: true,
          merchant: { merchantId: merchant.id, apiKeyId: key.id },
        });
      }
    });

    it('revokes a single key without affecting the others, idempotently', async () => {
      const { apiKey: first } = await merchants.provision({ name: 'Acme' });
      const { apiKey: second } = await merchants.issueKey('acme', {});

      const revoked = await apiKeys.revoke(first.id);
      const again = await apiKeys.revoke(first.prefix);

      expect(revoked.status).toBe('revoked');
      expect(again.revokedAt).toEqual(revoked.revokedAt);
      await expect(
        authenticator.authenticate(first.plaintext),
      ).resolves.toMatchObject({
        authenticated: false,
        reason: 'revoked',
      });
      await expect(
        authenticator.authenticate(second.plaintext),
      ).resolves.toMatchObject({
        authenticated: true,
      });
    });

    it('reports unknown keys on revocation', async () => {
      await expect(
        apiKeys.revoke('pgsk_0000000000000000'),
      ).rejects.toBeInstanceOf(ApiKeyNotFoundError);
    });

    it('rejects expired keys', async () => {
      const { apiKey } = await merchants.provision({
        name: 'Acme',
        firstKey: { expiresAt: new Date(Date.now() + 60_000) },
      });
      await ownerDatabase().merchantApiKey.update({
        where: { id: apiKey.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        authenticator.authenticate(apiKey.plaintext),
      ).resolves.toMatchObject({
        authenticated: false,
        reason: 'expired',
      });
      await expect(
        apiKeys.listForMerchant(apiKey.merchantId),
      ).resolves.toMatchObject([{ status: 'expired' }]);
    });

    it('scopes key lookups to the owning merchant', async () => {
      const { apiKey: acmeKey } = await merchants.provision({ name: 'Acme' });
      const { merchant: globex } = await merchants.provision({
        name: 'Globex',
      });

      await expect(
        apiKeys.findForMerchant(globex.id, acmeKey.id),
      ).resolves.toBeNull();
      await expect(
        apiKeys.findForMerchant(acmeKey.merchantId, acmeKey.id),
      ).resolves.toMatchObject({
        id: acmeKey.id,
      });
    });
  });

  describe('merchant status', () => {
    it('suspension blocks every key and reactivation restores them', async () => {
      const { apiKey: first } = await merchants.provision({ name: 'Acme' });
      const { apiKey: second } = await merchants.issueKey('acme', {});

      await merchants.setStatus('acme', MerchantStatus.SUSPENDED);
      for (const key of [first, second]) {
        await expect(
          authenticator.authenticate(key.plaintext),
        ).resolves.toMatchObject({
          authenticated: false,
          reason: 'merchant_suspended',
        });
      }

      const reactivated = await merchants.setStatus(
        'acme',
        MerchantStatus.ACTIVE,
      );
      expect(reactivated.status).toBe(MerchantStatus.ACTIVE);
      await expect(
        authenticator.authenticate(first.plaintext),
      ).resolves.toMatchObject({
        authenticated: true,
      });
    });
  });

  describe('authenticator', () => {
    it('distinguishes rejection reasons internally', async () => {
      const { apiKey } = await merchants.provision({ name: 'Acme' });
      const { prefix, secret } = parseApiKey(apiKey.plaintext)!;
      const otherSecret = (secret[0] === 'A' ? 'B' : 'A') + secret.slice(1);

      await expect(
        authenticator.authenticate('not-a-key'),
      ).resolves.toMatchObject({
        reason: 'malformed',
      });
      await expect(
        authenticator.authenticate(`pgsk_0123456789abcdef_${secret}`),
      ).resolves.toMatchObject({ reason: 'unknown_prefix' });
      await expect(
        authenticator.authenticate(`pgsk_${prefix}_${otherSecret}`),
      ).resolves.toMatchObject({ reason: 'invalid_secret', keyPrefix: prefix });
    });
  });
});
