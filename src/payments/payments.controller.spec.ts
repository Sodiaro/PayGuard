import { describe, expect, it } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import {
  IdempotencyKeyReusedError,
  PaymentNotFoundError,
  PaymentNotRetryableError,
} from './payment-errors.js';
import type { PaymentResponse } from './payment.responses.js';
import { PaymentsController } from './payments.controller.js';
import type {
  PaymentCommandResult,
  PaymentsService,
} from './payments.service.js';

const auth = { merchantId: 'merchant-1', apiKeyId: 'key-1' };
const body = { amount: 100, currency: 'USD' as const };
const payment = { id: 'payment-1' } as PaymentResponse;

function setup(command: () => Promise<PaymentCommandResult>) {
  const service = {
    create: command,
    retry: command,
    findForMerchant: () => Promise.resolve(null),
  } as unknown as PaymentsService;
  const sent: { status?: number; headers: Record<string, string> } = {
    headers: {},
  };
  const response = {
    status: (code: number) => {
      sent.status = code;
    },
    setHeader: (name: string, value: string) => {
      sent.headers[name] = value;
    },
  } as unknown as Response;
  const controller = new PaymentsController(service);
  return {
    sent,
    create: () => controller.create(auth, 'key', body, response),
    retry: () => controller.retry(auth, 'payment-1', 'key', response),
    get: () => controller.get(auth, 'missing'),
  };
}

describe('PaymentsController', () => {
  it.each(['create', 'retry'] as const)(
    'keeps the declared 202 for a new %s',
    async (operation) => {
      const subject = setup(() =>
        Promise.resolve({ payment, replayed: false }),
      );

      await expect(subject[operation]()).resolves.toBe(payment);
      expect(subject.sent).toEqual({ headers: {} });
    },
  );

  it.each(['create', 'retry'] as const)(
    'answers a %s replay with 200 and Idempotent-Replayed',
    async (operation) => {
      const subject = setup(() => Promise.resolve({ payment, replayed: true }));

      await subject[operation]();
      expect(subject.sent).toEqual({
        status: 200,
        headers: { 'Idempotent-Replayed': 'true' },
      });
    },
  );

  it.each([
    ['a reused key', new IdempotencyKeyReusedError(), ConflictException],
    [
      'an ineligible payment',
      new PaymentNotRetryableError('attempt_limit_reached'),
      ConflictException,
    ],
    ['a payment it cannot see', new PaymentNotFoundError(), NotFoundException],
  ])('maps %s to the HTTP error convention', async (_case, error, expected) => {
    await expect(
      setup(() => Promise.reject(error)).retry(),
    ).rejects.toBeInstanceOf(expected);
  });

  it('lets unexpected errors through untouched', async () => {
    const unexpected = new Error('database exploded');
    await expect(setup(() => Promise.reject(unexpected)).create()).rejects.toBe(
      unexpected,
    );
  });

  it('returns 404 for a payment it cannot see', async () => {
    const subject = setup(() => Promise.resolve({ payment, replayed: false }));
    await expect(subject.get()).rejects.toBeInstanceOf(NotFoundException);
  });
});
