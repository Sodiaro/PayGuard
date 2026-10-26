import { describe, expect, it } from '@jest/globals';
import { PaymentProviderName } from '../payments/providers/payment-provider.js';
import { SimulatorOutcome } from '../payments/providers/simulated-payment-provider.js';
import {
  isTrustedProxyEntry,
  NodeEnvironment,
  validateApiEnvironment,
  validateOperatorEnvironment,
  validateProcessingEnvironment,
} from './environment.js';

const DATABASE_URL =
  'postgresql://payguard:s3cret-value@localhost:5432/payguard';

// Variables with no default.
const REQUIRED = {
  NODE_ENV: 'development',
  DATABASE_URL,
  PAYMENT_PROVIDER: 'simulator',
};

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
    expect(validateApiEnvironment(REQUIRED)).toEqual({
      ...CORE_DEFAULTS,
      PAYMENT_PROVIDER: PaymentProviderName.Simulator,
      PORT: 3000,
      SWAGGER_ENABLED: false,
      CORS_ALLOWED_ORIGINS: [],
      OUTBOX_WORKER_ENABLED: true,
      RATE_LIMIT_IP_PER_MINUTE: 300,
      RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE: 60,
      TRUSTED_PROXIES: [],
      HEALTH_QUEUE_BACKLOG_SECONDS: 120,
      HEALTH_WORKER_TIMEOUT_SECONDS: 30,
      WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: 300,
    });
  });

  it('accepts a webhook secret and treats an empty one as unset', () => {
    const secret = 'whsec-0123456789abcdef0123456789abcdef';
    expect(
      validateApiEnvironment({ ...REQUIRED, SIMULATOR_WEBHOOK_SECRET: secret })
        .SIMULATOR_WEBHOOK_SECRET,
    ).toBe(secret);
    expect(
      validateApiEnvironment({ ...REQUIRED, SIMULATOR_WEBHOOK_SECRET: '' })
        .SIMULATOR_WEBHOOK_SECRET,
    ).toBeUndefined();
  });

  it('converts string values and drops undeclared variables', () => {
    const environment = validateApiEnvironment({
      NODE_ENV: 'test',
      PAYMENT_PROVIDER: 'simulator',
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
      WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: '120',
      PAYGUARD_OPERATOR: 'alice (on-call)',
      PATH: '/usr/bin',
    });

    expect(environment).toEqual({
      NODE_ENV: NodeEnvironment.Test,
      PAYMENT_PROVIDER: PaymentProviderName.Simulator,
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
      WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: 120,
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
    ['SIMULATOR_WEBHOOK_SECRET', 'too-short'],
    ['SIMULATOR_WEBHOOK_SECRET', 'contains a space 0123456789abcdef0123'],
    [
      'SIMULATOR_WEBHOOK_SECRET',
      'pgsk_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ],
    ['WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS', '0'],
    ['WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS', '3600'],
  ])('rejects %s=%s', (name, value) => {
    expect(() =>
      validateApiEnvironment({ ...REQUIRED, [name]: value }),
    ).toThrow(new RegExp(name));
  });

  it.each(['*', 'https://app.example.com/', 'app.example.com', 'ftp://x.io'])(
    'rejects CORS_ALLOWED_ORIGINS=%s',
    (origins) => {
      expect(() =>
        validateApiEnvironment({ ...REQUIRED, CORS_ALLOWED_ORIGINS: origins }),
      ).toThrow(/CORS_ALLOWED_ORIGINS/);
    },
  );

  it('rejects a missing or non-PostgreSQL DATABASE_URL', () => {
    expect(() =>
      validateApiEnvironment({ ...REQUIRED, DATABASE_URL: undefined }),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      validateApiEnvironment({
        ...REQUIRED,
        DATABASE_URL: 'mysql://localhost/payguard',
      }),
    ).toThrow(/postgresql:\/\/ connection string/);
  });

  it.each(['0', '70000', 'abc'])('rejects PORT=%s', (port) => {
    expect(() => validateApiEnvironment({ ...REQUIRED, PORT: port })).toThrow(
      /PORT/,
    );
  });

  it('rejects ambiguous boolean values instead of guessing', () => {
    expect(() =>
      validateApiEnvironment({ ...REQUIRED, SWAGGER_ENABLED: 'yes' }),
    ).toThrow(/SWAGGER_ENABLED/);
  });

  it('never includes variable values in the error message', () => {
    expect(() =>
      validateApiEnvironment({
        ...REQUIRED,
        PORT: 'not-a-port',
        NODE_ENV: 'x',
      }),
    ).toThrow(expect.not.stringContaining('s3cret-value'));
    expect(() =>
      validateApiEnvironment({
        ...REQUIRED,
        SIMULATOR_WEBHOOK_SECRET: 'short-secret-value',
      }),
    ).toThrow(expect.not.stringContaining('short-secret-value'));
  });
});

describe('payment provider selection', () => {
  const PRODUCTION = { ...REQUIRED, NODE_ENV: 'production' };

  it.each([
    ['the API', validateApiEnvironment],
    ['the standalone worker', validateProcessingEnvironment],
  ])(
    'requires an explicit, supported provider for %s',
    (_process, validate) => {
      expect(() =>
        validate({ ...REQUIRED, PAYMENT_PROVIDER: undefined }),
      ).toThrow(/PAYMENT_PROVIDER must be one of: simulator/);
      expect(() =>
        validate({ ...REQUIRED, PAYMENT_PROVIDER: 'stripe' }),
      ).toThrow(/PAYMENT_PROVIDER must be one of/);
      expect(() => validate({ ...REQUIRED, PAYMENT_PROVIDER: '' })).toThrow(
        /PAYMENT_PROVIDER/,
      );
      expect(validate(REQUIRED).PAYMENT_PROVIDER).toBe('simulator');
    },
  );

  it.each([
    ['the API', validateApiEnvironment],
    ['the standalone worker', validateProcessingEnvironment],
  ])('refuses the simulator in production for %s', (_process, validate) => {
    expect(() => validate(PRODUCTION)).toThrow(
      /PAYMENT_PROVIDER=simulator is not allowed when NODE_ENV=production/,
    );
    expect(() =>
      validate({ ...PRODUCTION, PAYMENT_PROVIDER: undefined }),
    ).toThrow(/PAYMENT_PROVIDER must be one of/);
  });

  it.each(['development', 'test'])(
    'allows the simulator with NODE_ENV=%s',
    (env) => {
      expect(
        validateProcessingEnvironment({ ...REQUIRED, NODE_ENV: env })
          .PAYMENT_PROVIDER,
      ).toBe('simulator');
    },
  );

  it.each([
    ['the API', validateApiEnvironment],
    ['the standalone worker', validateProcessingEnvironment],
    [
      'the operator CLI',
      (config: Record<string, unknown>) =>
        validateOperatorEnvironment({
          ...config,
          OPERATOR_DATABASE_URL: DATABASE_URL,
        }),
    ],
  ])('requires NODE_ENV to be set explicitly for %s', (_process, validate) => {
    expect(() => validate({ ...REQUIRED, NODE_ENV: undefined })).toThrow(
      /NODE_ENV must be one of the following values: development, test, production/,
    );
  });
});

describe('validateProcessingEnvironment', () => {
  it('validates only what the standalone worker needs', () => {
    expect(
      validateProcessingEnvironment({
        ...REQUIRED,
        PORT: 'not-a-port',
        TRUSTED_PROXIES: '0.0.0.0/0',
      }),
    ).toEqual({
      ...CORE_DEFAULTS,
      PAYMENT_PROVIDER: PaymentProviderName.Simulator,
    });
  });

  it('still requires the shared settings', () => {
    expect(() =>
      validateProcessingEnvironment({ ...REQUIRED, DATABASE_URL: undefined }),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      validateProcessingEnvironment({ ...REQUIRED, OUTBOX_LEASE_SECONDS: '5' }),
    ).toThrow(/OUTBOX_LEASE_SECONDS/);
  });
});

describe('validateOperatorEnvironment', () => {
  const OPERATOR_DATABASE_URL =
    'postgresql://payguard_cli:op3rator-value@localhost:5432/payguard';

  it('connects with the operator URL, never the runtime DATABASE_URL, and needs no provider', () => {
    const environment = validateOperatorEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL,
      OPERATOR_DATABASE_URL,
    });

    expect(environment.DATABASE_URL).toBe(OPERATOR_DATABASE_URL);
    expect(environment).not.toHaveProperty('PAYMENT_PROVIDER');
  });

  it('treats an empty PAYGUARD_OPERATOR, as Compose passes an unset one, as unset', () => {
    expect(
      validateOperatorEnvironment({
        NODE_ENV: 'development',
        OPERATOR_DATABASE_URL,
        PAYGUARD_OPERATOR: '',
      }).PAYGUARD_OPERATOR,
    ).toBeUndefined();
  });

  it('refuses to fall back to DATABASE_URL when OPERATOR_DATABASE_URL is missing', () => {
    expect(() =>
      validateOperatorEnvironment({ NODE_ENV: 'development', DATABASE_URL }),
    ).toThrow(
      /OPERATOR_DATABASE_URL must be a postgresql:\/\/ connection string/,
    );
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
