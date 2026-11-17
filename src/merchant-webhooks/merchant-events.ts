import { currentRequestId } from '../common/logging/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  MerchantEventDeliveryStatus,
  OutboxJobType,
  PaymentStatus,
  RefundStatus,
} from '../generated/prisma/enums.js';
import { enqueueOutboxJob } from '../outbox/outbox-store.js';
import {
  loadPaymentView,
  toPaymentResponse,
} from '../payments/payment-view.js';
import { toRefundResponse } from '../refunds/refund-view.js';

export const MerchantEventType = {
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_AUTHORIZED: 'payment.authorized',
  PAYMENT_CANCELED: 'payment.canceled',
  // A capture or void the provider refused; the payment stays AUTHORIZED.
  PAYMENT_CAPTURE_FAILED: 'payment.capture_failed',
  PAYMENT_VOID_FAILED: 'payment.void_failed',
  REFUND_SUCCEEDED: 'refund.succeeded',
  REFUND_FAILED: 'refund.failed',
} as const;

const PAYMENT_OUTCOME_EVENTS: Partial<
  Record<PaymentStatus, MerchantEventType>
> = {
  [PaymentStatus.SUCCEEDED]: MerchantEventType.PAYMENT_SUCCEEDED,
  [PaymentStatus.FAILED]: MerchantEventType.PAYMENT_FAILED,
  [PaymentStatus.AUTHORIZED]: MerchantEventType.PAYMENT_AUTHORIZED,
  [PaymentStatus.CANCELED]: MerchantEventType.PAYMENT_CANCELED,
};

export type MerchantEventType =
  (typeof MerchantEventType)[keyof typeof MerchantEventType];

export const MERCHANT_EVENT_TYPES = Object.values(MerchantEventType);

// Called with the transaction that records a payment's outcome (an attempt's, or a capture's or
// void's), so the event and its delivery job exist exactly when the outcome does. Without type, it
// follows the payment's new status. data is the payment as GET /v1/payments/:id would return it.
export async function recordPaymentOutcomeEvent(
  tx: Prisma.TransactionClient,
  paymentId: string,
  attemptId: string,
  type?: MerchantEventType,
): Promise<void> {
  const payment = await loadPaymentView(tx, paymentId);
  const eventType = type ?? PAYMENT_OUTCOME_EVENTS[payment.status];
  if (!eventType) {
    throw new Error(
      `Payment ${paymentId} is ${payment.status}, not an outcome`,
    );
  }
  await recordMerchantEvent(tx, {
    merchantId: payment.merchantId,
    type: eventType,
    paymentId,
    attemptId,
    data: toPaymentResponse(payment),
  });
}

export async function recordRefundOutcomeEvent(
  tx: Prisma.TransactionClient,
  refundId: string,
): Promise<void> {
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  await recordMerchantEvent(tx, {
    merchantId: refund.merchantId,
    type:
      refund.status === RefundStatus.SUCCEEDED
        ? MerchantEventType.REFUND_SUCCEEDED
        : MerchantEventType.REFUND_FAILED,
    paymentId: refund.paymentId,
    attemptId: refund.attemptId,
    refundId,
    data: toRefundResponse(refund),
  });
}

// A delivery is queued only if the merchant's endpoint is enabled now. Events recorded while it is
// not are still listed by GET /v1/events and can be redelivered once it is.
async function recordMerchantEvent(
  tx: Prisma.TransactionClient,
  event: {
    merchantId: string;
    type: MerchantEventType;
    paymentId: string;
    attemptId: string;
    refundId?: string;
    data: object;
  },
): Promise<void> {
  const endpoint = await tx.merchantWebhookEndpoint.findUnique({
    where: { merchantId: event.merchantId },
    select: { enabled: true },
  });
  const deliver = endpoint?.enabled === true;

  const created = await tx.merchantEvent.create({
    data: {
      merchantId: event.merchantId,
      type: event.type,
      paymentId: event.paymentId,
      attemptId: event.attemptId,
      refundId: event.refundId ?? null,
      data: JSON.parse(JSON.stringify(event.data)) as Prisma.InputJsonObject,
      deliveryStatus: deliver ? MerchantEventDeliveryStatus.PENDING : null,
    },
    select: { id: true },
  });
  if (deliver) {
    await enqueueOutboxJob(tx, {
      type: OutboxJobType.DELIVER_MERCHANT_EVENT,
      paymentId: event.paymentId,
      attemptId: event.attemptId,
      merchantEventId: created.id,
      requestId: currentRequestId(),
    });
  }
}

// What the merchant receives, and what GET /v1/events returns as the event itself.
export function merchantEventEnvelope(event: {
  id: string;
  type: string;
  createdAt: Date;
  data: Prisma.JsonValue;
}) {
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt.toISOString(),
    data: event.data,
  };
}
