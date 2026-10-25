import { Inject, Injectable } from '@nestjs/common';
import { requestContext } from '../common/logging/request-context.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { OutboxJobType, PaymentStatus } from '../generated/prisma/enums.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { applyAttemptResolution } from './attempt-outcomes.js';
import {
  fingerprintPaymentRequest,
  fingerprintRetryRequest,
} from './idempotency.js';
import {
  IdempotencyKeyReusedError,
  PaymentNotFoundError,
  PaymentNotRetryableError,
  PaymentStateConflictError,
} from './payment-errors.js';
import {
  paymentStatusesThatCanBecome,
  resolveAttempt,
  retryEligibility,
} from './payment-lifecycle.js';
import type { CreatePaymentRequest } from './payment.requests.js';
import type { PaymentResponse } from './payment.responses.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderPaymentResult,
} from './providers/payment-provider.js';

const WITH_ATTEMPTS = {
  attempts: { orderBy: { attemptNumber: 'asc' } },
} satisfies Prisma.PaymentInclude;

type PaymentRecord = Prisma.PaymentGetPayload<{
  include: typeof WITH_ATTEMPTS;
}>;

type RetryRequestRecord = Prisma.PaymentRetryRequestGetPayload<object>;

export interface PaymentCommandResult {
  payment: PaymentResponse;
  replayed: boolean;
}

// Commands only record intent: each new attempt is committed together with the outbox job that
// will submit it, and the provider is contacted later by the outbox worker.
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxStore,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async create(
    merchantId: string,
    idempotencyKey: string,
    request: CreatePaymentRequest,
  ): Promise<PaymentCommandResult> {
    const requestFingerprint = fingerprintPaymentRequest(request);

    const existing = await this.findByIdempotencyKey(
      merchantId,
      idempotencyKey,
    );
    if (existing) return this.replayCreate(existing, requestFingerprint);

    let paymentId: string;
    try {
      paymentId = await this.prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: {
            merchantId,
            amount: BigInt(request.amount),
            currency: request.currency,
            reference: request.reference ?? null,
            idempotencyKey,
            requestFingerprint,
            attempts: {
              create: { attemptNumber: 1, provider: this.provider.id },
            },
          },
          include: WITH_ATTEMPTS,
        });
        await this.outbox.enqueue(tx, {
          type: OutboxJobType.PROCESS_ATTEMPT,
          paymentId: payment.id,
          attemptId: payment.attempts[0].id,
          requestId: currentRequestId(),
        });
        return payment.id;
      });
    } catch (error) {
      // A concurrent request with the same key won the insert; answer with its payment.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findByIdempotencyKey(
        merchantId,
        idempotencyKey,
      );
      if (!winner) throw error;
      return this.replayCreate(winner, requestFingerprint);
    }

    return {
      payment: await this.requireForMerchant(merchantId, paymentId),
      replayed: false,
    };
  }

  async retry(
    merchantId: string,
    paymentId: string,
    idempotencyKey: string,
  ): Promise<PaymentCommandResult> {
    const requestFingerprint = fingerprintRetryRequest(paymentId);

    const existing = await this.findRetryRequest(merchantId, idempotencyKey);
    if (existing) return this.replayRetry(existing, requestFingerprint);

    let raced: RetryRequestRecord | null;
    try {
      raced = await this.prisma.$transaction(async (tx) => {
        // Serializes concurrent retries of one payment: the eligibility check and the new attempt
        // below are only correct while no other transaction can add an attempt.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM payments
          WHERE id = ${paymentId}::uuid AND merchant_id = ${merchantId}::uuid
          FOR UPDATE`;
        if (locked.length === 0) throw new PaymentNotFoundError();

        const sameKey = await tx.paymentRetryRequest.findUnique({
          where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } },
        });
        if (sameKey) return sameKey;

        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          include: WITH_ATTEMPTS,
        });
        const eligibility = retryEligibility(payment, payment.attempts);
        if (!eligibility.eligible) {
          throw new PaymentNotRetryableError(eligibility.reason);
        }

        const attempt = await tx.paymentAttempt.create({
          data: {
            paymentId,
            attemptNumber: payment.attempts.at(-1)!.attemptNumber + 1,
            provider: this.provider.id,
          },
        });
        const reopened = await tx.payment.updateMany({
          where: {
            id: paymentId,
            status: { in: paymentStatusesThatCanBecome(PaymentStatus.PENDING) },
          },
          data: { status: PaymentStatus.PENDING },
        });
        if (reopened.count !== 1)
          throw new PaymentStateConflictError(paymentId);

        await tx.paymentRetryRequest.create({
          data: {
            merchantId,
            idempotencyKey,
            requestFingerprint,
            paymentId,
            attemptId: attempt.id,
          },
        });
        await this.outbox.enqueue(tx, {
          type: OutboxJobType.PROCESS_ATTEMPT,
          paymentId,
          attemptId: attempt.id,
          requestId: currentRequestId(),
        });
        return null;
      });
    } catch (error) {
      // The same key was used concurrently for a different payment, so no shared row lock applied.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findRetryRequest(merchantId, idempotencyKey);
      if (!winner) throw error;
      return this.replayRetry(winner, requestFingerprint);
    }

    if (raced) return this.replayRetry(raced, requestFingerprint);
    return {
      payment: await this.requireForMerchant(merchantId, paymentId),
      replayed: false,
    };
  }

  async findForMerchant(
    merchantId: string,
    paymentId: string,
  ): Promise<PaymentResponse | null> {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, merchantId },
      include: WITH_ATTEMPTS,
    });
    return payment && toResponse(payment);
  }

  // Returns false when the attempt already has an outcome; see applyAttemptResolution.
  async recordAttemptOutcome(
    attemptId: string,
    result: ProviderPaymentResult,
  ): Promise<boolean> {
    return this.prisma.$transaction((tx) =>
      applyAttemptResolution(tx, attemptId, resolveAttempt(result)),
    );
  }

  private async requireForMerchant(
    merchantId: string,
    paymentId: string,
  ): Promise<PaymentResponse> {
    const payment = await this.findForMerchant(merchantId, paymentId);
    if (!payment) throw new PaymentNotFoundError();
    return payment;
  }

  private findByIdempotencyKey(
    merchantId: string,
    idempotencyKey: string,
  ): Promise<PaymentRecord | null> {
    return this.prisma.payment.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } },
      include: WITH_ATTEMPTS,
    });
  }

  private findRetryRequest(
    merchantId: string,
    idempotencyKey: string,
  ): Promise<RetryRequestRecord | null> {
    return this.prisma.paymentRetryRequest.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } },
    });
  }

  // Replays return the current state, which may have progressed since the original response.
  private replayCreate(
    payment: PaymentRecord,
    requestFingerprint: string,
  ): PaymentCommandResult {
    if (payment.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyKeyReusedError();
    }
    return { payment: toResponse(payment), replayed: true };
  }

  private async replayRetry(
    retry: RetryRequestRecord,
    requestFingerprint: string,
  ): Promise<PaymentCommandResult> {
    if (retry.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyKeyReusedError();
    }
    return {
      payment: await this.requireForMerchant(retry.merchantId, retry.paymentId),
      replayed: true,
    };
  }
}

function currentRequestId(): string | null {
  return requestContext.getStore()?.requestId ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function toResponse(payment: PaymentRecord): PaymentResponse {
  const latest = payment.attempts.at(-1);
  return {
    id: payment.id,
    amount: Number(payment.amount),
    currency: payment.currency,
    status: payment.status,
    reference: payment.reference,
    failureCode:
      payment.status === PaymentStatus.FAILED
        ? (latest?.failureCode ?? null)
        : null,
    attempts: payment.attempts.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      provider: attempt.provider,
      status: attempt.status,
      providerReference: attempt.providerReference,
      failureCode: attempt.failureCode,
      createdAt: attempt.createdAt,
      completedAt: attempt.completedAt,
    })),
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}
