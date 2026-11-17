import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentMerchant } from '../auth/auth.decorators.js';
import type { AuthenticatedMerchant } from '../auth/authenticated-merchant.js';
import { ErrorResponse } from '../common/http/error-response.js';
import { PaymentCreationRateLimitGuard } from '../common/rate-limit/rate-limit.guards.js';
import { IdempotencyKey } from '../payments/idempotency-key.decorator.js';
import { IdempotencyKeyReusedError } from '../payments/payment-errors.js';
import { InsufficientBalanceError } from './payout-errors.js';
import { CreatePayoutRequest, ListPayoutsQuery } from './payout.requests.js';
import {
  BalanceResponse,
  PayoutListResponse,
  PayoutResponse,
} from './payout.responses.js';
import { PayoutsService } from './payouts.service.js';

@ApiTags('Balance and payouts')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponse })
@ApiTooManyRequestsResponse({
  type: ErrorResponse,
  description: 'Rate limit exceeded; see the Retry-After header',
})
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get('balance')
  @ApiOperation({
    summary: "The merchant's balance in each currency",
    description:
      'Derived from succeeded payments (what they captured), refunds and payouts. Pending refunds and ' +
      'payouts are already deducted from available.',
  })
  @ApiOkResponse({ type: BalanceResponse })
  balance(
    @CurrentMerchant() auth: AuthenticatedMerchant,
  ): Promise<BalanceResponse> {
    return this.payouts.balance(auth.merchantId);
  }

  @Post('payouts')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PaymentCreationRateLimitGuard)
  @ApiOperation({
    summary:
      'Pay out part of the available balance to a bank account (simulated provider)',
    description:
      'Returns 202 with the payout PENDING; poll GET /v1/payouts/{id} for the outcome. Refused with 409 ' +
      'above the available balance in that currency. A failed payout returns its amount to the ' +
      'available balance. Repeating the Idempotency-Key with the same request replays (200, ' +
      'Idempotent-Replayed: true).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per operation, 1-255 visible ASCII characters (e.g. a UUID)',
  })
  @ApiAcceptedResponse({
    type: PayoutResponse,
    description: 'Payout created and queued',
  })
  @ApiOkResponse({ type: PayoutResponse, description: 'Idempotent replay' })
  @ApiBadRequestResponse({ type: ErrorResponse })
  @ApiConflictResponse({
    type: ErrorResponse,
    description:
      'Amount above the available balance, or Idempotency-Key reused for another request',
  })
  async create(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CreatePayoutRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayoutResponse> {
    try {
      const { payout, replayed } = await this.payouts.create(
        auth.merchantId,
        idempotencyKey,
        body,
      );
      if (replayed) {
        response.status(HttpStatus.OK);
        response.setHeader('Idempotent-Replayed', 'true');
      }
      return payout;
    } catch (error) {
      if (
        error instanceof IdempotencyKeyReusedError ||
        error instanceof InsufficientBalanceError
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get('payouts')
  @ApiOperation({ summary: "The merchant's payouts, newest first" })
  @ApiOkResponse({ type: PayoutListResponse })
  @ApiBadRequestResponse({ type: ErrorResponse })
  list(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Query() query: ListPayoutsQuery,
  ): Promise<PayoutListResponse> {
    return this.payouts.list(auth.merchantId, query);
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: 'Get a payout owned by the authenticated merchant' })
  @ApiOkResponse({ type: PayoutResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async get(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayoutResponse> {
    const payout = await this.payouts.find(auth.merchantId, id);
    if (!payout) throw new NotFoundException('Payout not found');
    return payout;
  }
}
