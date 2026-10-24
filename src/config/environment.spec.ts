import { describe, expect, it } from '@jest/globals';
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
    });
  });

  it('converts string values and drops undeclared variables', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'production',
      PORT: '8080',
      DATABASE_URL,
      SWAGGER_ENABLED: 'true',
      CORS_ALLOWED_ORIGINS: ' https://app.example.com, http://localhost:5173 ,',
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
    });
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
