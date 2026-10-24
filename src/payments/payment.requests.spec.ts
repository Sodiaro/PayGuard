import { describe, expect, it } from '@jest/globals';
import { createValidationPipe } from '../common/http/validation.js';
import type { RequestValidationException } from '../common/http/validation.js';
import { MAX_PAYMENT_AMOUNT } from './currencies.js';
import { CreatePaymentRequest } from './payment.requests.js';

// Runs the real global pipe, so whitelist/forbid rules are exercised exactly as in production.
const pipe = createValidationPipe();
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: CreatePaymentRequest });

async function fieldsRejected(body: unknown): Promise<string[]> {
  try {
    await validate(body);
  } catch (error) {
    return (error as RequestValidationException).details.map((d) => d.field);
  }
  return [];
}

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
