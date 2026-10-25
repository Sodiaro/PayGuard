import { describe, expect, it } from '@jest/globals';
import { SimulatorOutcome } from '../payments/providers/simulated-payment-provider.js';
import {
  isTrustedProxyEntry,
  NodeEnvironment,
  validateApiEnvironment,
  validateCoreEnvironment,
} from './environment.js';

const DATABASE_URL =
  'postgresql://payguard:s3cret-value@localhost:5432/payguard';

const CORE_DEFAULTS = {
  NODE_ENV: NodeEnvironment.Development,
  DATABASE_URL,
  PAYMENT_SIMULATOR_OUTCOME: SimulatorOutcome.Succeeded,
  PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: false,
  OUTBOX_POLL_INTERVAL_MS: 1000,
  OUTBOX_LEASE_SECONDS: 60,
  OUTBOX_MAX_RUNS: 10,
  OUTBOX_BACKOFF_MAX_SECONDS: 300,
  RECONCILIATION_DELAY_SECONDS: 60,
};

describe('validateApiEnvironment', () => {
  it('applies defaults when only the required variables are set', () => {
    expect(validateApiEnvironment({ DATABASE_URL })).toEqual({
      ...CORE_DEFAULTS,
      PORT: 3000,
      SWAGGER_ENABLED: false,
      CORS_ALLOWED_ORIGINS: [],
      OUTBOX_WORKER_ENABLED: true,
      RATE_LIMIT_IP_PER_MINUTE: 300,
      RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE: 60,
      TRUSTED_PROXIES: [],
      HEALTH_QUEUE_BACKLOG_SECONDS: 120,
      HEALTH_WORKER_TIMEOUT_SECONDS: 30,
    });
  });

  it('converts string values and drops undeclared variables', () => {
    const environment = validateApiEnvironment({
      NODE_ENV: 'production',
      PORT: '8080',
      DATABASE_URL,
      SWAGGER_ENABLED: 'true',
      CORS_ALLOWED_ORIGINS: ' https://app.example.com, http://localhost:5173 ,',
      PAYMENT_SIMULATOR_OUTCOME: 'DECLINED',
      PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: 'true',
      OUTBOX_WORKER_ENABLED: 'false',
      OUTBOX_POLL_INTERVAL_MS: '250',
      OUTBOX_LEASE_SECONDS: '120',
      OUTBOX_MAX_RUNS: '5',
      OUTBOX_BACKOFF_MAX_SECONDS: '60',
      RECONCILIATION_DELAY_SECONDS: '30',
      RATE_LIMIT_IP_PER_MINUTE: '1000',
      RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE: '5',
      TRUSTED_PROXIES: '10.0.0.0/8, 2001:db8::/32 ,loopback',
      HEALTH_QUEUE_BACKLOG_SECONDS: '300',
      HEALTH_WORKER_TIMEOUT_SECONDS: '60',
      PAYGUARD_OPERATOR: 'alice (on-call)',
      PATH: '/usr/bin',
    });

    expect(environment).toEqual({
      NODE_ENV: NodeEnvironment.Production,
      DATABASE_URL,
      PAYMENT_SIMULATOR_OUTCOME: SimulatorOutcome.Declined,
      PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: true,
      OUTBOX_POLL_INTERVAL_MS: 250,
      OUTBOX_LEASE_SECONDS: 120,
      OUTBOX_MAX_RUNS: 5,
      OUTBOX_BACKOFF_MAX_SECONDS: 60,
      RECONCILIATION_DELAY_SECONDS: 30,
      PAYGUARD_OPERATOR: 'alice (on-call)',
      PORT: 8080,
      SWAGGER_ENABLED: true,
      CORS_ALLOWED_ORIGINS: [
        'https://app.example.com',
        'http://localhost:5173',
      ],
      OUTBOX_WORKER_ENABLED: false,
      RATE_LIMIT_IP_PER_MINUTE: 1000,
      RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE: 5,
      TRUSTED_PROXIES: ['10.0.0.0/8', '2001:db8::/32', 'loopback'],
      HEALTH_QUEUE_BACKLOG_SECONDS: 300,
      HEALTH_WORKER_TIMEOUT_SECONDS: 60,
    });
  });

  it.each([
    ['PAYMENT_SIMULATOR_OUTCOME', 'succeeded'],
    ['PAYMENT_SIMULATOR_OUTCOME', 'RANDOM'],
    ['RATE_LIMIT_IP_PER_MINUTE', '0'],
    ['RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE', '2.5'],
    ['OUTBOX_WORKER_ENABLED', 'yes'],
    ['OUTBOX_LEASE_SECONDS', '10'],
    ['OUTBOX_POLL_INTERVAL_MS', '0'],
    ['OUTBOX_MAX_RUNS', '0'],
    ['RECONCILIATION_DELAY_SECONDS', 'soon'],
    ['HEALTH_WORKER_TIMEOUT_SECONDS', '10'],
    ['HEALTH_QUEUE_BACKLOG_SECONDS', '0'],
    ['TRUSTED_PROXIES', '0.0.0.0/0'],
    ['TRUSTED_PROXIES', '::/0'],
    ['TRUSTED_PROXIES', 'proxy.internal'],
    ['TRUSTED_PROXIES', '10.0.0.1/33'],
    ['TRUSTED_PROXIES', 'true'],
    ['PAYGUARD_OPERATOR', 'tab\there'],
  ])('rejects %s=%s', (name, value) => {
    expect(() =>
      validateApiEnvironment({ DATABASE_URL, [name]: value }),
    ).toThrow(new RegExp(name));
  });

  it.each(['*', 'https://app.example.com/', 'app.example.com', 'ftp://x.io'])(
    'rejects CORS_ALLOWED_ORIGINS=%s',
    (origins) => {
      expect(() =>
        validateApiEnvironment({ DATABASE_URL, CORS_ALLOWED_ORIGINS: origins }),
      ).toThrow(/CORS_ALLOWED_ORIGINS/);
    },
  );

  it('rejects a missing or non-PostgreSQL DATABASE_URL', () => {
    expect(() => validateApiEnvironment({})).toThrow(/DATABASE_URL/);
    expect(() =>
      validateApiEnvironment({ DATABASE_URL: 'mysql://localhost/payguard' }),
    ).toThrow(/postgresql:\/\/ connection string/);
  });

  it.each(['0', '70000', 'abc'])('rejects PORT=%s', (port) => {
    expect(() => validateApiEnvironment({ DATABASE_URL, PORT: port })).toThrow(
      /PORT/,
    );
  });

  it('rejects ambiguous boolean values instead of guessing', () => {
    expect(() =>
      validateApiEnvironment({ DATABASE_URL, SWAGGER_ENABLED: 'yes' }),
    ).toThrow(/SWAGGER_ENABLED/);
  });

  it('never includes variable values in the error message', () => {
    expect(() =>
      validateApiEnvironment({
        DATABASE_URL,
        PORT: 'not-a-port',
        NODE_ENV: 'x',
      }),
    ).toThrow(expect.not.stringContaining('s3cret-value'));
  });
});

describe('validateCoreEnvironment', () => {
  it('validates only what non-HTTP processes need', () => {
    expect(
      validateCoreEnvironment({
        DATABASE_URL,
        PORT: 'not-a-port',
        TRUSTED_PROXIES: '0.0.0.0/0',
      }),
    ).toEqual(CORE_DEFAULTS);
  });

  it('still requires the shared settings', () => {
    expect(() => validateCoreEnvironment({})).toThrow(/DATABASE_URL/);
    expect(() =>
      validateCoreEnvironment({ DATABASE_URL, OUTBOX_LEASE_SECONDS: '5' }),
    ).toThrow(/OUTBOX_LEASE_SECONDS/);
  });
});

describe('isTrustedProxyEntry', () => {
  it.each([
    'loopback',
    'uniquelocal',
    '10.0.0.5',
    '10.0.0.0/8',
    '192.168.1.0/24',
    '::1',
    'fd00::/8',
  ])('accepts %s', (entry) => {
    expect(isTrustedProxyEntry(entry)).toBe(true);
  });

  it.each(['0.0.0.0/0', '::/0', '10.0.0.0/', '10.0.0.0/x', '1.2.3', 'any'])(
    'rejects %s',
    (entry) => {
      expect(isTrustedProxyEntry(entry)).toBe(false);
    },
  );
});
