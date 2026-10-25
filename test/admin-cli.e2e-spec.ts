import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyAuthenticator } from '../src/auth/api-key-authenticator.service.js';
import { runAdminCli } from '../src/cli/admin-cli.js';
import { SimulatedWebhookSender } from '../src/cli/simulated-webhook-sender.js';
import type { PrismaService } from '../src/database/prisma.service.js';
import { OperatorAuditLog } from '../src/audit/operator-audit-log.js';
import { ApiKeysService } from '../src/merchants/api-keys.service.js';
import { MerchantsService } from '../src/merchants/merchants.service.js';
import { OutboxStore } from '../src/outbox/outbox-store.js';
import { PaymentInvestigator } from '../src/payments/payment-investigation.js';
import { createTestApp, prismaOf } from './support/test-app.js';
import { resetDatabase } from './support/test-database.js';

const ISSUED_KEY_LINE = /^\s+(pgsk_[0-9a-f]{16}_[A-Za-z0-9_-]{43})$/;

// Assertions compare booleans and counts so a failing test never prints a key into the report.
describe('Admin CLI (PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authenticator: ApiKeyAuthenticator;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = prismaOf(app);
    authenticator = app.get(ApiKeyAuthenticator);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function run(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAdminCli(
      argv,
      {
        merchants: app.get(MerchantsService),
        apiKeys: app.get(ApiKeysService),
        outbox: app.get(OutboxStore),
        audit: new OperatorAuditLog(prismaOf(app)),
        simulator: new SimulatedWebhookSender(
          prismaOf(app),
          app.get(ConfigService),
        ),
        investigator: new PaymentInvestigator(prismaOf(app)),
        actor: 'test-operator',
      },
      { out: (line) => out.push(line), err: (line) => err.push(line) },
    );
    const keys = out.flatMap((line) => ISSUED_KEY_LINE.exec(line)?.[1] ?? []);
    return { code, out: out.join('\n'), err: err.join('\n'), keys };
  }

  it('provisions a merchant and prints its key exactly once', async () => {
    const result = await run(
      'merchant:create',
      '--name',
      'Acme Ltd',
      '--key-label',
      'production',
    );

    expect(result.code).toBe(0);
    expect(result.keys).toHaveLength(1);
    const [key] = result.keys;
    expect(result.out.split(key).length - 1).toBe(1);
    expect(result.out).toContain('shown once');
    expect(result.out).toContain('slug:   acme-ltd');
    const auth = await authenticator.authenticate(key);
    expect(auth.authenticated).toBe(true);
  });

  it('refuses to provision the same merchant twice', async () => {
    await run('merchant:create', '--name', 'Acme Ltd');
    const retry = await run('merchant:create', '--name', 'Acme Ltd');

    expect(retry.code).toBe(1);
    expect(retry.err).toContain('already exists');
    expect(retry.keys).toHaveLength(0);
    await expect(prisma.merchantApiKey.count()).resolves.toBe(1);
  });

  it('issues, lists and revokes keys without ever re-printing a secret', async () => {
    const created = await run(
      'merchant:create',
      '--name',
      'Acme',
      '--slug',
      'acme',
    );
    const rotated = await run(
      'key:create',
      '--merchant',
      'acme',
      '--label',
      'rotation',
    );
    const [firstKey] = created.keys;
    const [secondKey] = rotated.keys;
    expect(rotated.code).toBe(0);
    expect(secondKey === firstKey).toBe(false);

    const listed = await run('key:list', '--merchant', 'acme');
    const merchantsListed = await run('merchant:list');
    for (const output of [listed.out, merchantsListed.out]) {
      expect(output.includes(firstKey) || output.includes(secondKey)).toBe(
        false,
      );
    }
    expect(listed.out).toContain(firstKey.slice(0, 21));
    expect(listed.out).toContain('label=rotation');

    const revoked = await run('key:revoke', '--key', firstKey.slice(0, 21));
    expect(revoked.code).toBe(0);
    expect(revoked.out).toContain('revoked at');
    expect((await authenticator.authenticate(firstKey)).authenticated).toBe(
      false,
    );
    expect((await authenticator.authenticate(secondKey)).authenticated).toBe(
      true,
    );
  });

  it('suspends and reactivates a merchant', async () => {
    const [key] = (
      await run('merchant:create', '--name', 'Acme', '--slug', 'acme')
    ).keys;

    const suspended = await run('merchant:suspend', '--merchant', 'acme');
    expect(suspended.out).toBe('Merchant acme is now SUSPENDED');
    expect((await authenticator.authenticate(key)).authenticated).toBe(false);

    const reactivated = await run('merchant:reactivate', '--merchant', 'acme');
    expect(reactivated.out).toBe('Merchant acme is now ACTIVE');
    expect((await authenticator.authenticate(key)).authenticated).toBe(true);
  });

  it.each([
    [['merchant:explode'], 'Unknown command'],
    [['merchant:create'], 'Missing required option --name'],
    [
      ['merchant:create', '--name', 'Acme', '--colour', 'red'],
      "Unknown option '--colour'",
    ],
    [
      ['merchant:create', '--name', 'Acme', '--key-expires-at', 'tomorrow'],
      'Key expiry must be',
    ],
    [
      ['merchant:suspend', '--merchant', 'nobody'],
      'Merchant "nobody" not found',
    ],
    [['key:revoke', '--key', 'pgsk_0000000000000000'], 'not found'],
  ])('fails cleanly for %j', async (argv, message) => {
    const result = await run(...argv);

    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
  });
});
