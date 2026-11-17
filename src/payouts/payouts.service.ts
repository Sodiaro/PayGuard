import { Injectable } from '@nestjs/common';
import { currentRequestId } from '../common/logging/request-context.js';
import { isUniqueViolation } from '../database/prisma-errors.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  OutboxJobType,
  PaymentEventSource,
  PayoutStatus,
} from '../generated/prisma/enums.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { fingerprintPayoutRequest } from '../payments/idempotency.js';
import { IdempotencyKeyReusedError } from '../payments/payment-errors.js';
import {
  decodePaymentCursor,
  encodePaymentCursor,
} from '../payments/payment-cursor.js';
import { DEFAULT_PAGE_SIZE } from '../payments/payment.requests.js';
import { loadBalances, loadCurrencyBalance, lockBalance } from './balance.js';
import { InsufficientBalanceError } from './payout-errors.js';
import { PayoutEventType, recordPayoutEvent } from './payout-events.js';
import { toBalanceResponse, toPayoutResponse } from './payout-view.js';
import type {
  CreatePayoutRequest,
  ListPayoutsQuery,
} from './payout.requests.js';
import type {
  BalanceResponse,
  PayoutListResponse,
  PayoutResponse,
} from './payout.responses.js';

type PayoutRecord = Prisma.PayoutGetPayload<object>;

export interface PayoutCommandResult {
  payout: PayoutResponse;
  replayed: boolean;
}

// Creating a payout only records intent: it commits with the outbox job that submits it, and the
// amount leaves the available balance at once, so it cannot be paid out twice.
@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxStore,
  ) {}

  async balance(merchantId: string): Promise<BalanceResponse> {
    const balances = await loadBalances(this.prisma, merchantId);
    return { balances: balances.map(toBalanceResponse) };
  }

  async create(
    merchantId: string,
    idempotencyKey: string,
    request: CreatePayoutRequest,
  ): Promise<PayoutCommandResult> {
    const requestFingerprint = fingerprintPayoutRequest(request);

    const existing = await this.findByIdempotencyKey(
      merchantId,
      idempotencyKey,
    );
    if (existing) return replay(existing, requestFingerprint);

    let outcome: { payout: PayoutRecord; raced: boolean };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // Payouts of this merchant and currency are decided one at a time; the database trigger
        // takes the same lock and enforces the same limit if this is ever bypassed.
        await lockBalance(tx, merchantId, request.currency);

        const sameKey = await this.findByIdempotencyKey(
          merchantId,
          idempotencyKey,
          tx,
        );
        if (sameKey) return { payout: sameKey, raced: true };

        const balance = await loadCurrencyBalance(
          tx,
          merchantId,
          request.currency,
        );
        if (BigInt(request.amount) > balance.available) {
          throw new InsufficientBalanceError(
            request.currency,
            balance.available,
          );
        }

        const payout = await tx.payout.create({
          data: {
            merchantId,
            amount: request.amount,
            currency: request.currency,
            bankCode: request.destination.bankCode,
            accountNumber: request.destination.accountNumber,
            accountName: request.destination.accountName,
            reference: request.reference ?? null,
            idempotencyKey,
            requestFingerprint,
          },
        });
        await this.outbox.enqueue(tx, {
          type: OutboxJobType.PROCESS_PAYOUT,
          payoutId: payout.id,
          requestId: currentRequestId(),
        });
        await recordPayoutEvent(tx, {
          payoutId: payout.id,
          type: PayoutEventType.PAYOUT_CREATED,
          source: PaymentEventSource.MERCHANT,
          statusAfter: PayoutStatus.PENDING,
        });
        return { payout, raced: false };
      });
    } catch (error) {
      // A concurrent request with the same key, for another currency, won the insert.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findByIdempotencyKey(
        merchantId,
        idempotencyKey,
      );
      if (!winner) throw error;
      return replay(winner, requestFingerprint);
    }

    if (outcome.raced) return replay(outcome.payout, requestFingerprint);
    return { payout: toPayoutResponse(outcome.payout), replayed: false };
  }

  // Keyset pagination on (createdAt, id), newest first, like payments.
  async list(
    merchantId: string,
    query: ListPayoutsQuery,
  ): Promise<PayoutListResponse> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.cursor ? decodePaymentCursor(query.cursor) : null;
    const where: Prisma.PayoutWhereInput = {
      merchantId,
      status: query.status,
      currency: query.currency,
    };
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const rows = await this.prisma.payout.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toPayoutResponse),
      nextCursor:
        rows.length > limit && last
          ? encodePaymentCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async find(
    merchantId: string,
    payoutId: string,
  ): Promise<PayoutResponse | null> {
    const payout = await this.prisma.payout.findFirst({
      where: { id: payoutId, merchantId },
    });
    return payout && toPayoutResponse(payout);
  }

  private findByIdempotencyKey(
    merchantId: string,
    idempotencyKey: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<PayoutRecord | null> {
    return db.payout.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } },
    });
  }
}

// Replays return the payout's current state, which may have progressed since the first response.
function replay(
  payout: PayoutRecord,
  requestFingerprint: string,
): PayoutCommandResult {
  if (payout.requestFingerprint !== requestFingerprint) {
    throw new IdempotencyKeyReusedError();
  }
  return { payout: toPayoutResponse(payout), replayed: true };
}
