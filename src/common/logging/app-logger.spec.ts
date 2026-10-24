import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { generateApiKey } from '../../auth/api-key.js';
import { AppLogger } from './app-logger.js';
import { requestContext } from './request-context.js';

describe('AppLogger (JSON)', () => {
  const logger = new AppLogger({ json: true });
  const key = generateApiKey().plaintext;
  let written: string[];

  beforeEach(() => {
    written = [];
    const capture = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    jest.spyOn(process.stdout, 'write').mockImplementation(capture);
    jest.spyOn(process.stderr, 'write').mockImplementation(capture);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const records = () =>
    written.map((line) => JSON.parse(line) as Record<string, unknown>);

  it('writes one JSON object per line with flattened params', () => {
    logger.log('Request completed', { statusCode: 200 }, 'HTTP');

    expect(records()).toEqual([
      expect.objectContaining({
        level: 'log',
        message: 'Request completed',
        context: 'HTTP',
        statusCode: 200,
      }),
    ]);
  });

  it('masks sensitive keys at any depth', () => {
    logger.warn('Outbound call', {
      headers: { Authorization: 'Bearer abc', 'x-request-id': 'r-1' },
      password: 'hunter2',
    });

    const [record] = records();
    expect(record.headers).toEqual({
      Authorization: '[REDACTED]',
      'x-request-id': 'r-1',
    });
    expect(record.password).toBe('[REDACTED]');
  });

  it('scrubs API keys from messages, param values, stacks and errors', () => {
    logger.log(`Saw ${key} in a message`, { note: `header was Bearer ${key}` });
    logger.error(`Failed with ${key}`, `Error: boom ${key}\n    at x`);
    logger.error(new Error(`thrown with ${key}`));

    const output = written.join('');
    expect(output.includes(key)).toBe(false);
    expect(output).toContain('pgsk_[REDACTED]');
  });

  it('adds request correlation from the async context', () => {
    requestContext.run({ requestId: 'req-42', merchantId: 'm-1' }, () => {
      logger.log('Inside a request');
    });
    logger.log('Outside a request');

    const [inside, outside] = records();
    expect(inside).toMatchObject({ requestId: 'req-42', merchantId: 'm-1' });
    expect(outside).not.toHaveProperty('requestId');
  });
});
