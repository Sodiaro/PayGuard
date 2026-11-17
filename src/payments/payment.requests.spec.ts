import { describe, expect, it } from '@jest/globals';
import { createValidationPipe } from '../common/http/validation.js';
import type { RequestValidationException } from '../common/http/validation.js';
import { MAX_PAYMENT_AMOUNT } from './currencies.js';
import { encodePaymentCursor } from './payment-cursor.js';
import { CreatePaymentRequest, ListPaymentsQuery } from './payment.requests.js';

// Runs the real global pipe, so whitelist/forbid rules are exercised exactly as in production.
const pipe = createValidationPipe();
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: CreatePaymentRequest });
const validateQuery = (query: unknown) =>
  pipe.transform(query, { type: 'query', metatype: ListPaymentsQuery });

async function rejectedBy(run: () => Promise<unknown>): Promise<string[]> {
  try {
    await run();
  } catch (error) {
    return (error as RequestValidationException).details.map((d) => d.field);
  }
  return [];
}

const fieldsRejected = (body: unknown) => rejectedBy(() => validate(body));
const queryFieldsRejected = (query: unknown) =>
  rejectedBy(() => validateQuery(query));

describe('CreatePaymentRequest validation', () => {
  it('accepts a minimal valid request', async () => {
    await expect(
      validate({ amount: 500000, currency: 'NGN' }),
    ).resolves.toEqual({
      amount: 500000,
      currency: 'NGN',
    });
  });

  it('accepts zero- and three-decimal currencies without conversion', async () => {
    await expect(
      validate({ amount: 500, currency: 'JPY' }),
    ).resolves.toMatchObject({ amount: 500 });
    await expect(
      validate({ amount: 1500, currency: 'KWD' }),
    ).resolves.toMatchObject({ amount: 1500 });
  });

  it.each([
    ['zero', 0],
    ['negative', -100],
    ['fractional', 10.5],
    ['numeric string', '5000'],
    ['above the maximum', MAX_PAYMENT_AMOUNT + 1],
    ['not finite', Number.POSITIVE_INFINITY],
  ])('rejects a %s amount', async (_case, amount) => {
    await expect(fieldsRejected({ amount, currency: 'NGN' })).resolves.toEqual([
      'amount',
    ]);
  });

  it.each(['XYZ', 'ngn', 'NG', 'NAIRA', 123])(
    'rejects currency %j',
    async (currency) => {
      await expect(fieldsRejected({ amount: 100, currency })).resolves.toEqual([
        'currency',
      ]);
    },
  );

  it.each(['', 'has space', 'x'.repeat(65), 'quote"s'])(
    'rejects reference %j',
    async (reference) => {
      await expect(
        fieldsRejected({ amount: 100, currency: 'USD', reference }),
      ).resolves.toEqual(['reference']);
    },
  );

  it('rejects server-owned fields a client might try to set', async () => {
    const rejected = await fieldsRejected({
      amount: 100,
      currency: 'USD',
      merchantId: '0190a1b2-0000-7000-8000-000000000000',
      status: 'SUCCEEDED',
      attemptId: 'x',
      providerResponse: { approved: true },
    });
    expect(rejected.sort()).toEqual([
      'attemptId',
      'merchantId',
      'providerResponse',
      'status',
    ]);
  });
});

describe('ListPaymentsQuery validation', () => {
  it('accepts no filters', async () => {
    await expect(validateQuery({})).resolves.toEqual({});
  });

  it('accepts every filter, converting limit from its query string', async () => {
    const cursor = encodePaymentCursor({
      createdAt: new Date('2026-10-24T01:01:56.974Z'),
      id: '01a16b6d-bf6d-765f-98fb-39c95d75fe23',
    });
    await expect(
      validateQuery({
        status: 'FAILED',
        reference: 'order_10042',
        createdFrom: '2026-10-01T00:00:00Z',
        createdTo: '2026-11-01T00:00:00.000Z',
        limit: '50',
        cursor,
      }),
    ).resolves.toEqual({
      status: 'FAILED',
      reference: 'order_10042',
      createdFrom: '2026-10-01T00:00:00Z',
      createdTo: '2026-11-01T00:00:00.000Z',
      limit: 50,
      cursor,
    });
  });

  it.each([
    ['an unknown status', { status: 'DONE' }, ['status']],
    ['a lowercase status', { status: 'failed' }, ['status']],
    ['a repeated status', { status: ['FAILED', 'PENDING'] }, ['status']],
    ['an invalid reference', { reference: 'has space' }, ['reference']],
    [
      'a date that is not ISO 8601',
      { createdFrom: 'yesterday' },
      ['createdFrom'],
    ],
    [
      'an impossible date',
      { createdTo: '2026-02-30T00:00:00Z' },
      ['createdTo'],
    ],
    ['a zero limit', { limit: '0' }, ['limit']],
    ['a limit above the maximum', { limit: '101' }, ['limit']],
    ['a fractional limit', { limit: '2.5' }, ['limit']],
    ['a non-numeric limit', { limit: 'ten' }, ['limit']],
    ['a forged cursor', { cursor: 'abc' }, ['cursor']],
    ['an unknown parameter', { merchantId: 'x' }, ['merchantId']],
  ])('rejects %s', async (_case, query, fields) => {
    await expect(queryFieldsRejected(query)).resolves.toEqual(fields);
  });
});
