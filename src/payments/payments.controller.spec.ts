import { describe, expect, it } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { IdempotencyKeyReusedError } from './payment-errors.js';
import type { PaymentResponse } from './payment.responses.js';
import { PaymentsController } from './payments.controller.js';
import type {
  CreatePaymentResult,
  PaymentsService,
} from './payments.service.js';

const auth = { merchantId: 'merchant-1', apiKeyId: 'key-1' };
const body = { amount: 100, currency: 'USD' as const };
const payment = { id: 'payment-1' } as PaymentResponse;

function setup(create: () => Promise<CreatePaymentResult>) {
  const service = {
    create,
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
  return { controller: new PaymentsController(service), response, sent };
}

describe('PaymentsController', () => {
  it('keeps the default 201 for a new payment', async () => {
    const { controller, response, sent } = setup(() =>
      Promise.resolve({ payment, replayed: false }),
    );

    await expect(controller.create(auth, 'key', body, response)).resolves.toBe(
      payment,
    );
    expect(sent.status).toBeUndefined();
    expect(sent.headers).toEqual({});
  });

  it('answers a replay with 200 and Idempotent-Replayed', async () => {
    const { controller, response, sent } = setup(() =>
      Promise.resolve({ payment, replayed: true }),
    );

    await controller.create(auth, 'key', body, response);
    expect(sent.status).toBe(200);
    expect(sent.headers).toEqual({ 'Idempotent-Replayed': 'true' });
  });

  it('maps a reused key to 409 and lets other errors through untouched', async () => {
    const conflict = setup(() =>
      Promise.reject(new IdempotencyKeyReusedError()),
    );
    await expect(
      conflict.controller.create(auth, 'key', body, conflict.response),
    ).rejects.toBeInstanceOf(ConflictException);

    const unexpected = new Error('database exploded');
    const failing = setup(() => Promise.reject(unexpected));
    await expect(
      failing.controller.create(auth, 'key', body, failing.response),
    ).rejects.toBe(unexpected);
  });

  it('returns 404 for a payment it cannot see', async () => {
    const { controller } = setup(() =>
      Promise.resolve({ payment, replayed: false }),
    );
    await expect(controller.get(auth, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
