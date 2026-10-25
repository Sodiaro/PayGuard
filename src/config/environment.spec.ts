import { describe, expect, it } from '@jest/globals';
import { SimulatorOutcome } from '../payments/providers/simulated-payment-provider.js';
import { NodeEnvironment, validateEnvironment } from './environment.js';

const DATABASE_URL =
  'postgresql://payguard:s3cret-value@localhost:5432/payguard';

describe('validateEnvironment', () => {
  it('applies defaults when only the required variables are set', () => {
    const environment = validateEnvironment({ DATABASE_URL });

    expect(environment).toEqual({
      NODE_ENV: NodeEnvironment.Development,
      PORT: 3000,
      DATABASE_URL,
      SWAGGER_ENABLED: false,
      CORS_ALLOWED_ORIGINS: [],
      PAYMENT_SIMULATOR_OUTCOME: SimulatorOutcome.Succeeded,
      RATE_LIMIT_IP_PER_MINUTE: 300,
      RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE: 60,
      TRUST_PROXY_HOPS: 0,
      PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: false,
      OUTBOX_WORKER_ENABLED: true,
      OUTBOX_POLL_INTERVAL_MS: 1000,
      OUTBOX_LEASE_SECONDS: 60,
      OUTBOX_MAX_RUNS: 10,
      OUTBOX_BACKOFF_MAX_SECONDS: 300,
      RECONCILIATION_DELAY_SECONDS: 60,
    });
  });

  it('converts string values and drops undeclared variables', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'production',
      PORT: '8080',
      DATABASE_URL,
      SWAGGER_ENABLED: 'true',
      CORS_ALLOWED_ORIGINS: ' https://app.example.com, http://localhost:5173 ,',
      PAYMENT_SIMULATOR_OUTCOME: 'DECLINED',
      RATE_LIMIT_IP_PER_MINUTE: '1000',
      RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE: '5',
      TRUST_PROXY_HOPS: '1',
      PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: 'true',
      OUTBOX_WORKER_ENABLED: 'false',
      OUTBOX_POLL_INTERVAL_MS: '250',
      OUTBOX_LEASE_SECONDS: '120',
      OUTBOX_MAX_RUNS: '5',
      OUTBOX_BACKOFF_MAX_SECONDS: '60',
      RECONCILIATION_DELAY_SECONDS: '30',
      PATH: '/usr/bin',
    });

    expect(environment).toEqual({
      NODE_ENV: NodeEnvironment.Production,
      PORT: 8080,
      DATABASE_URL,
      SWAGGER_ENABLED: true,
      CORS_ALLOWED_ORIGINS: [
        'https://app.example.com',
        'http://localhost:5173',
      ],
      PAYMENT_SIMULATOR_OUTCOME: SimulatorOutcome.Declined,
      RATE_LIMIT_IP_PER_MINUTE: 1000,
      RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE: 5,
      TRUST_PROXY_HOPS: 1,
      PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: true,
      OUTBOX_WORKER_ENABLED: false,
      OUTBOX_POLL_INTERVAL_MS: 250,
      OUTBOX_LEASE_SECONDS: 120,
      OUTBOX_MAX_RUNS: 5,
      OUTBOX_BACKOFF_MAX_SECONDS: 60,
      RECONCILIATION_DELAY_SECONDS: 30,
    });
  });

  it.each([
    ['PAYMENT_SIMULATOR_OUTCOME', 'succeeded'],
    ['PAYMENT_SIMULATOR_OUTCOME', 'RANDOM'],
    ['RATE_LIMIT_IP_PER_MINUTE', '0'],
    ['RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE', '2.5'],
    ['TRUST_PROXY_HOPS', '-1'],
    ['OUTBOX_WORKER_ENABLED', 'yes'],
    ['OUTBOX_LEASE_SECONDS', '10'],
    ['OUTBOX_POLL_INTERVAL_MS', '0'],
    ['OUTBOX_MAX_RUNS', '0'],
    ['RECONCILIATION_DELAY_SECONDS', 'soon'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => validateEnvironment({ DATABASE_URL, [name]: value })).toThrow(
      new RegExp(name),
    );
  });

  it.each(['*', 'https://app.example.com/', 'app.example.com', 'ftp://x.io'])(
    'rejects CORS_ALLOWED_ORIGINS=%s',
    (origins) => {
      expect(() =>
        validateEnvironment({ DATABASE_URL, CORS_ALLOWED_ORIGINS: origins }),
      ).toThrow(/CORS_ALLOWED_ORIGINS/);
    },
  );

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnvironment({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    expect(() =>
      validateEnvironment({ DATABASE_URL: 'mysql://localhost/payguard' }),
    ).toThrow(/postgresql:\/\/ connection string/);
  });

  it.each(['0', '70000', 'abc'])('rejects PORT=%s', (port) => {
    expect(() => validateEnvironment({ DATABASE_URL, PORT: port })).toThrow(
      /PORT/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() =>
      validateEnvironment({ DATABASE_URL, NODE_ENV: 'staging' }),
    ).toThrow(/NODE_ENV/);
  });

  it('rejects ambiguous boolean values instead of guessing', () => {
    expect(() =>
      validateEnvironment({ DATABASE_URL, SWAGGER_ENABLED: 'yes' }),
    ).toThrow(/SWAGGER_ENABLED/);
  });

  it('never includes variable values in the error message', () => {
    expect(() =>
      validateEnvironment({ DATABASE_URL, PORT: 'not-a-port', NODE_ENV: 'x' }),
    ).toThrow(expect.not.stringContaining('s3cret-value'));
  });
});
