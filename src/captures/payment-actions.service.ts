import { Injectable } from '@nestjs/common';
import { currentRequestId } from '../common/logging/request-context.js';
import { isUniqueViolation } from '../database/prisma-errors.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  OutboxJobType,
  PaymentActionType,
  PaymentEventSource,
  PaymentActionStatus,
} from '../generated/prisma/enums.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { fingerprintPaymentActionRequest } from '../payments/idempotency.js';
import {
  IdempotencyKeyReusedError,
  PaymentNotFoundError,
} from '../payments/payment-errors.js';
import {
  PaymentEventType,
  recordPaymentEvent,
} from '../payments/payment-events.js';
import {
  PAYMENT_VIEW_INCLUDE,
  toPaymentResponse,
} from '../payments/payment-view.js';
import type { PaymentCommandResult } from '../payments/payments.service.js';
import { PaymentActionNotAllowedError } from './payment-action-errors.js';
import { actionEligibility } from './payment-action-lifecycle.js';

type ActionRecord = Prisma.PaymentActionGetPayload<object>;

// Capturing or voiding records intent only, like payments and refunds: the action is committed
// together with the outbox job that submits it, and the worker contacts the provider later.
// Responses are the payment, whose actions show the new one.
@Injectable()
export class PaymentActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxStore,
  ) {}

  capture(
    merchantId: string,
    paymentId: string,
    idempotencyKey: string,
    amount: number | undefined,
  ): Promise<PaymentCommandResult> {
    return this.act(
      merchantId,
      paymentId,
      idempotencyKey,
      PaymentActionType.CAPTURE,
      amount,
    );
  }

  void(
    merchantId: string,
    paymentId: string,
    idempotencyKey: string,
  ): Promise<PaymentCommandResult> {
    return this.act(
      merchantId,
      paymentId,
      idempotencyKey,
      PaymentActionType.VOID,
      undefined,
    );
  }

  private async act(
    merchantId: string,
    paymentId: string,
    idempotencyKey: string,
    type: PaymentActionType,
    amount: number | undefined,
  ): Promise<PaymentCommandResult> {
    const requestFingerprint = fingerprintPaymentActionRequest(
      paymentId,
      type,
      amount,
    );
    const existing = await this.findByIdempotencyKey(
      merchantId,
      idempotencyKey,
    );
    if (existing) return this.replay(existing, requestFingerprint);

    let raced: ActionRecord | null;
    try {
      raced = await this.prisma.$transaction(async (tx) => {
        // Serializes actions and refunds of one payment: eligibility below stays correct only
        // while nothing else can act on it. The database trigger and the one-pending index
        // enforce the same rules if this is ever bypassed.
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
        if (sameKey) return sameKey;

        // One query per relation: see loadPaymentView.
        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          select: { status: true, captureMethod: true, amount: true },
        });
        const attempts = await tx.paymentAttempt.findMany({
          where: { paymentId },
          select: { id: true, status: true },
        });
        const actions = await tx.paymentAction.findMany({
          where: { paymentId },
          select: { status: true },
        });
        const eligibility = actionEligibility(
          payment,
          attempts,
          actions,
          type,
          amount === undefined ? null : BigInt(amount),
        );
        if (!eligibility.eligible) {
          throw new PaymentActionNotAllowedError(
            type === PaymentActionType.CAPTURE ? 'captured' : 'voided',
            eligibility.reason,
          );
        }

        const action = await tx.paymentAction.create({
          data: {
            merchantId,
            paymentId,
            attemptId: eligibility.attemptId,
            type,
            amount: eligibility.amount,
            idempotencyKey,
            requestFingerprint,
          },
        });
        await this.outbox.enqueue(tx, {
          type: OutboxJobType.PROCESS_PAYMENT_ACTION,
          paymentId,
          attemptId: action.attemptId,
          paymentActionId: action.id,
          requestId: currentRequestId(),
        });
        await recordPaymentEvent(tx, {
          paymentId,
          attemptId: action.attemptId,
          paymentActionId: action.id,
          type: PaymentEventType.ACTION_CREATED,
          source: PaymentEventSource.MERCHANT,
          details: {
            actionType: type,
            actionStatusAfter: PaymentActionStatus.PENDING,
            ...(type === PaymentActionType.CAPTURE && {
              fullCapture: amount === undefined,
            }),
          },
        });
        return null;
      });
    } catch (error) {
      // A concurrent request with the same key, for another payment, won the insert.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findByIdempotencyKey(
        merchantId,
        idempotencyKey,
      );
      if (!winner) throw error;
      return this.replay(winner, requestFingerprint);
    }

    if (raced) return this.replay(raced, requestFingerprint);
    return { payment: await this.payment(paymentId), replayed: false };
  }

  // Replays return the payment's current state, which may have progressed since.
  private async replay(
    action: ActionRecord,
    requestFingerprint: string,
  ): Promise<PaymentCommandResult> {
    if (action.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyKeyReusedError();
    }
    return { payment: await this.payment(action.paymentId), replayed: true };
  }

  private async payment(paymentId: string) {
    return toPaymentResponse(
      await this.prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: PAYMENT_VIEW_INCLUDE,
      }),
    );
  }

  private findByIdempotencyKey(
    merchantId: string,
    idempotencyKey: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ActionRecord | null> {
    return db.paymentAction.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } },
    });
  }
}
