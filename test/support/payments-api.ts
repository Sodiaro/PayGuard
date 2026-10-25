import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { PaymentResponse } from '../../src/payments/payment.responses.js';
import type { provisionMerchant } from './test-app.js';

export type Merchant = Awaited<ReturnType<typeof provisionMerchant>>;

export const ORDER = {
  amount: 500000,
  currency: 'NGN',
  reference: 'order_10042',
};

export function paymentsApi(app: INestApplication<App>) {
  const server = () => app.getHttpServer();
  return {
    create(
      merchant: Merchant,
      idempotencyKey: string | undefined,
      body: unknown = ORDER,
    ) {
      const req = request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${merchant.apiKey}`);
      if (idempotencyKey !== undefined) {
        req.set('Idempotency-Key', idempotencyKey);
      }
      return req.send(body as object);
    },
    retry(merchant: Merchant, paymentId: string, idempotencyKey?: string) {
      const req = request(server())
        .post(`/v1/payments/${paymentId}/retry`)
        .set('Authorization', `Bearer ${merchant.apiKey}`);
      if (idempotencyKey !== undefined) {
        req.set('Idempotency-Key', idempotencyKey);
      }
      return req.send();
    },
    get(merchant: Merchant, paymentId: string) {
      return request(server())
        .get(`/v1/payments/${paymentId}`)
        .set('Authorization', `Bearer ${merchant.apiKey}`);
    },
    async read(
      merchant: Merchant,
      paymentId: string,
    ): Promise<PaymentResponse> {
      const response = await this.get(merchant, paymentId).expect(200);
      return response.body as PaymentResponse;
    },
  };
}
