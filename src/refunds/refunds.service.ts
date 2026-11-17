import { Injectable } from '@nestjs/common';
import { currentRequestId } from '../common/logging/request-context.js';
import { isUniqueViolation } from '../database/prisma-errors.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  OutboxJobType,
  PaymentEventSource,
  RefundStatus,
} from '../generated/prisma/enums.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { fingerprintRefundRequest } from '../payments/idempotency.js';
import {
  IdempotencyKeyReusedError,
  PaymentNotFoundError,
} from '../payments/payment-errors.js';
import {
  PaymentEventType,
  recordPaymentEvent,
} from '../payments/payment-events.js';
import { RefundNotAllowedError } from './refund-errors.js';
import { refundEligibility } from './refund-lifecycle.js';
import type { CreateRefundRequest } from './refund.requests.js';
import type { RefundResponse } from './refund.responses.js';

type RefundRecord = Prisma.RefundGetPayload<object>;

export interface RefundCommandResult {
  refund: RefundResponse;
  replayed: boolean;
}

// Like payments, creating a refund only records intent: the refund is committed together with
// the outbox job that will submit it, and the provider is contacted later by the worker.
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxStore,
  ) {}

  async create(
    merchantId: string,
    paymentId: string,
    idempotencyKey: string,
    request: CreateRefundRequest,
  ): Promise<RefundCommandResult> {
    const requestFingerprint = fingerprintRefundRequest(paymentId, request);

    const existing = await this.findByIdempotencyKey(
      merchantId,
      idempotencyKey,
    );
    if (existing) return replay(existing, requestFingerprint);

    let outcome: { refund: RefundRecord; raced: boolean };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // Serializes refunds of one payment: the refundable amount checked below stays correct
        // only while no other transaction can add a refund. The database trigger enforces the
        // same limit if this is ever bypassed.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM payments
          WHERE id = ${paymentId}::uuid AND merchant_id = ${merchantId}::uuid
          FOR UPDATE`;
        if (locked.length === 0) throw new PaymentNotFoundError();

        const sameKey = await this.findByIdempotencyKey(
          merchantId,
          idempotencyKey,
          tx,
        );
        if (sameKey) return { refund: sameKey, raced: true };

        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          select: {
            status: true,
            amount: true,
            currency: true,
            attempts: { select: { id: true, status: true } },
            refunds: { select: { amount: true, status: true } },
          },
        });
        const eligibility = refundEligibility(
          payment,
          payment.attempts,
          payment.refunds,
          request.amount === undefined ? null : BigInt(request.amount),
        );
        if (!eligibility.eligible) {
          throw new RefundNotAllowedError(eligibility.reason);
        }

        const refund = await tx.refund.create({
          data: {
            merchantId,
            paymentId,
            attemptId: eligibility.attemptId,
            amount: eligibility.amount,
            currency: payment.currency,
            reference: request.reference ?? null,
            idempotencyKey,
            requestFingerprint,
          },
        });
        await this.outbox.enqueue(tx, {
          type: OutboxJobType.PROCESS_REFUND,
          paymentId,
          attemptId: refund.attemptId,
          refundId: refund.id,
          requestId: currentRequestId(),
        });
        await recordPaymentEvent(tx, {
          paymentId,
          attemptId: refund.attemptId,
          refundId: refund.id,
          type: PaymentEventType.REFUND_CREATED,
          source: PaymentEventSource.MERCHANT,
          details: {
            refundStatusAfter: RefundStatus.PENDING,
            fullRefund: request.amount === undefined,
          },
        });
        return { refund, raced: false };
      });
    } catch (error) {
      // A concurrent request with the same key, for another payment, won the insert.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findByIdempotencyKey(
        merchantId,
        idempotencyKey,
      );
      if (!winner) throw error;
      return replay(winner, requestFingerprint);
    }

    // A same-key request for this payment committed first while this one waited for the lock.
    if (outcome.raced) return replay(outcome.refund, requestFingerprint);
    return { refund: toRefundResponse(outcome.refund), replayed: false };
  }

  async listForPayment(
    merchantId: string,
    paymentId: string,
  ): Promise<RefundResponse[] | null> {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, merchantId },
      select: {
        refunds: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    return payment && payment.refunds.map(toRefundResponse);
  }

  async findForMerchant(
    merchantId: string,
    refundId: string,
  ): Promise<RefundResponse | null> {
    const refund = await this.prisma.refund.findFirst({
      where: { id: refundId, merchantId },
    });
    return refund && toRefundResponse(refund);
  }

  private findByIdempotencyKey(
    merchantId: string,
    idempotencyKey: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<RefundRecord | null> {
    return db.refund.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } },
    });
  }
}

// Replays return the refund's current state, which may have progressed since the first response.
function replay(
  refund: RefundRecord,
  requestFingerprint: string,
): RefundCommandResult {
  if (refund.requestFingerprint !== requestFingerprint) {
    throw new IdempotencyKeyReusedError();
  }
  return { refund: toRefundResponse(refund), replayed: true };
}

export function toRefundResponse(refund: RefundRecord): RefundResponse {
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
