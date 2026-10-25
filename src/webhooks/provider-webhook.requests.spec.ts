import { describe, expect, it } from '@jest/globals';
import {
  RequestValidationException,
  createValidationPipe,
} from '../common/http/validation.js';
import {
  fingerprintWebhookEvent,
  ProviderWebhookEvent,
} from './provider-webhook.requests.js';

const EVENT = {
  id: 'evt_0123456789abcdef01234567',
  type: 'payment.succeeded',
  createdAt: '2026-10-25T12:00:00.000Z',
  data: {
    attemptId: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b',
    providerReference: 'sim_7b4affd0040515a3582e3ba9',
    amount: 500000,
    currency: 'NGN',
  },
};

const pipe = createValidationPipe();
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: ProviderWebhookEvent });

async function fieldsRejected(body: unknown): Promise<string[]> {
  try {
    await validate(body);
  } catch (error) {
    if (error instanceof RequestValidationException) {
      return error.details.map((detail) => detail.field);
    }
    throw error;
  }
  return [];
}

describe('ProviderWebhookEvent validation', () => {
  it('accepts a well-formed event', async () => {
    await expect(validate(EVENT)).resolves.toBeInstanceOf(ProviderWebhookEvent);
  });

  it.each([
    [
      'an unsupported event type',
      { ...EVENT, type: 'payment.refunded' },
      'type',
    ],
    ['a malformed event ID', { ...EVENT, id: 'evt-1' }, 'id'],
    [
      'a local timestamp',
      { ...EVENT, createdAt: '2026-10-25T12:00:00+01:00' },
      'createdAt',
    ],
    [
      'an impossible date',
      { ...EVENT, createdAt: '2026-02-30T12:00:00Z' },
      'createdAt',
    ],
    ['a missing data object', { ...EVENT, data: undefined }, 'data'],
    ['data that is not an object', { ...EVENT, data: 'x' }, 'data'],
    [
      'an uppercase attempt ID',
      {
        ...EVENT,
        data: { ...EVENT.data, attemptId: EVENT.data.attemptId.toUpperCase() },
      },
      'data.attemptId',
    ],
    [
      'an amount as a string',
      { ...EVENT, data: { ...EVENT.data, amount: '500000' } },
      'data.amount',
    ],
    [
      'a fractional amount',
      { ...EVENT, data: { ...EVENT.data, amount: 1.5 } },
      'data.amount',
    ],
    [
      'an unsupported currency',
      { ...EVENT, data: { ...EVENT.data, currency: 'XYZ' } },
      'data.currency',
    ],
    [
      'a reference with spaces',
      { ...EVENT, data: { ...EVENT.data, providerReference: 'a b' } },
      'data.providerReference',
    ],
  ])('rejects %s', async (_case, body, field) => {
    await expect(fieldsRejected(body)).resolves.toContain(field);
  });

  it.each([
    ['a merchant ID', { ...EVENT, merchantId: 'm' }, 'merchantId'],
    [
      'a payment status',
      { ...EVENT, data: { ...EVENT.data, status: 'SUCCEEDED' } },
      'data.status',
    ],
    [
      'a payment ID',
      { ...EVENT, data: { ...EVENT.data, paymentId: 'p' } },
      'data.paymentId',
    ],
  ])('rejects undeclared fields such as %s', async (_case, body, field) => {
    await expect(fieldsRejected(body)).resolves.toContain(field);
  });
});

describe('fingerprintWebhookEvent', () => {
  const fingerprint = (event: unknown) =>
    fingerprintWebhookEvent(event as ProviderWebhookEvent);

  it('ignores serialization details: key order and timestamp precision', () => {
    const reordered = {
      data: {
        currency: 'NGN',
        amount: 500000,
        providerReference: EVENT.data.providerReference,
        attemptId: EVENT.data.attemptId,
      },
      createdAt: '2026-10-25T12:00:00Z',
      type: EVENT.type,
      id: EVENT.id,
    };
    expect(fingerprint(reordered)).toBe(fingerprint(EVENT));
  });

  it.each([
    ['type', { ...EVENT, type: 'payment.declined' }],
    ['amount', { ...EVENT, data: { ...EVENT.data, amount: 500001 } }],
    [
      'reference',
      { ...EVENT, data: { ...EVENT.data, providerReference: 'x' } },
    ],
    ['creation time', { ...EVENT, createdAt: '2026-10-25T12:00:01.000Z' }],
  ])('changes when the %s changes', (_field, changed) => {
    expect(fingerprint(changed)).not.toBe(fingerprint(EVENT));
  });
});
