import type { Prisma } from '../generated/prisma/client.js';
import type { RefundResponse } from './refund.responses.js';

export function toRefundResponse(
  refund: Prisma.RefundGetPayload<object>,
): RefundResponse {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    amount: Number(refund.amount),
    currency: refund.currency,
    status: refund.status,
    reference: refund.reference,
    providerReference: refund.providerReference,
    failureCode: refund.failureCode,
    createdAt: refund.createdAt,
    completedAt: refund.completedAt,
  };
}
