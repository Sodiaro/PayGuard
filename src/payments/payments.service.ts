import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PaymentStatus } from '../generated/prisma/enums.js';
import { fingerprintPaymentRequest } from './idempotency.js';
import {
  IdempotencyKeyReusedError,
  PaymentStateConflictError,
  ProviderTimeoutError,
} from './payment-errors.js';
import {
  attemptStatusesThatCanBecome,
  paymentStatusesThatCanBecome,
  resolveAttempt,
  type AttemptResolution,
} from './payment-lifecycle.js';
import type { CreatePaymentRequest } from './payment.requests.js';
import type { PaymentResponse } from './payment.responses.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderPaymentResult,
} from './providers/payment-provider.js';

const PROVIDER_TIMEOUT_MS = 10_000;

const WITH_ATTEMPTS = {
  attempts: { orderBy: { attemptNumber: 'asc' } },
} satisfies Prisma.PaymentInclude;

type PaymentRecord = Prisma.PaymentGetPayload<{
  include: typeof WITH_ATTEMPTS;
}>;

export interface CreatePaymentResult {
  payment: PaymentResponse;
  replayed: boolean;
}

// The provider is called outside any transaction. An attempt still PENDING after a crash or an
// indefinite provider answer has an unknown outcome and is never retried automatically.
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async create(
    merchantId: string,
    idempotencyKey: string,
    request: CreatePaymentRequest,
  ): Promise<CreatePaymentResult> {
    const requestFingerprint = fingerprintPaymentRequest(request);

    const existing = await this.findByIdempotencyKey(
      merchantId,
      idempotencyKey,
    );
    if (existing) return this.replay(existing, requestFingerprint);

    let payment: PaymentRecord;
    try {
      payment = await this.prisma.payment.create({
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
    } catch (error) {
      // A concurrent request with the same key won the insert; answer with its payment.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findByIdempotencyKey(
        merchantId,
        idempotencyKey,
      );
      if (!winner) throw error;
      return this.replay(winner, requestFingerprint);
    }

    await this.processAttempt(payment, payment.attempts[0].id);
    const current = await this.findForMerchant(merchantId, payment.id);
    return { payment: current!, replayed: false };
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

  // Applies a definite provider answer. Returns false when the attempt already has an outcome,
  // so a late or duplicate result can never overwrite a terminal state.
  async recordAttemptOutcome(
    attemptId: string,
    result: ProviderPaymentResult,
  ): Promise<boolean> {
    return this.applyResolution(attemptId, resolveAttempt(result));
  }

  private async processAttempt(
    payment: PaymentRecord,
    attemptId: string,
  ): Promise<void> {
    let resolution: AttemptResolution;
    try {
      const result = await withTimeout(
        this.provider.processPayment({
          attemptId,
          merchantId: payment.merchantId,
          amount: Number(payment.amount),
          currency: payment.currency,
        }),
        PROVIDER_TIMEOUT_MS,
      );
      resolution = resolveAttempt(result);
    } catch (error) {
      // Not a failure: the provider may have processed the payment. Recording FAILED here could
      // lead to a second charge on retry, so the attempt stays PENDING.
      this.logger.error(
        `Provider ${this.provider.id} gave no definite outcome for attempt ${attemptId} of payment ${payment.id}; left PENDING`,
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }

    const applied = await this.applyResolution(attemptId, resolution);
    if (!applied) {
      this.logger.warn(
        `Attempt ${attemptId} already had an outcome; provider result ignored`,
      );
    }
  }

  private async applyResolution(
    attemptId: string,
    resolution: AttemptResolution,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await tx.paymentAttempt.updateMany({
        where: {
          id: attemptId,
          status: {
            in: attemptStatusesThatCanBecome(resolution.attemptStatus),
          },
        },
        data: {
          status: resolution.attemptStatus,
          providerReference: resolution.providerReference,
          failureCode: resolution.failureCode,
          completedAt: new Date(),
        },
      });
      if (attempt.count === 0) return false;

      const { paymentId } = await tx.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
        select: { paymentId: true },
      });
      const payment = await tx.payment.updateMany({
        where: {
          id: paymentId,
          status: {
            in: paymentStatusesThatCanBecome(resolution.paymentStatus),
          },
        },
        data: { status: resolution.paymentStatus },
      });
      if (payment.count !== 1) throw new PaymentStateConflictError(paymentId);
      return true;
    });
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

  // Returns the current state, which may have progressed since the original response.
  private replay(
    payment: PaymentRecord,
    requestFingerprint: string,
  ): CreatePaymentResult {
    if (payment.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyKeyReusedError();
    }
    return { payment: toResponse(payment), replayed: true };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ProviderTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
