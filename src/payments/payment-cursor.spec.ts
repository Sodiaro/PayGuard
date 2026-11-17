import { describe, expect, it } from '@jest/globals';
import { decodePaymentCursor, encodePaymentCursor } from './payment-cursor.js';

const position = {
  createdAt: new Date('2026-10-24T01:01:56.974Z'),
  id: '01a16b6d-bf6d-765f-98fb-39c95d75fe23',
};

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('payment cursor', () => {
  it('round-trips a position exactly, to the millisecond', () => {
    const cursor = encodePaymentCursor(position);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePaymentCursor(cursor)).toEqual(position);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['an object', encode({ t: position.createdAt, id: position.id })],
    ['one element', encode([position.createdAt.toISOString()])],
    ['three elements', encode(['2026-10-24T01:01:56.974Z', position.id, 1])],
    ['a numeric time', encode([1792843200000, position.id])],
    ['a non-canonical time', encode(['2026-10-24', position.id])],
    ['an invalid time', encode(['2026-13-40T00:00:00.000Z', position.id])],
    ['an invalid id', encode([position.createdAt.toISOString(), 'x'])],
    [
      'an uppercase id',
      encode([position.createdAt.toISOString(), position.id.toUpperCase()]),
    ],
    ['oversized', 'A'.repeat(201)],
  ])('rejects %s', (_case, value) => {
    expect(decodePaymentCursor(value)).toBeNull();
  });
});
