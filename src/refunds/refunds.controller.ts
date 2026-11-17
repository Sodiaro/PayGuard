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
import {
  IdempotencyKeyReusedError,
  PaymentNotFoundError,
} from '../payments/payment-errors.js';
import { RefundNotAllowedError } from './refund-errors.js';
import { CreateRefundRequest } from './refund.requests.js';
import { RefundResponse } from './refund.responses.js';
import { RefundsService } from './refunds.service.js';

@ApiTags('Refunds')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponse })
@ApiTooManyRequestsResponse({
  type: ErrorResponse,
  description: 'Rate limit exceeded; see the Retry-After header',
})
@Controller()
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post('payments/:id/refunds')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PaymentCreationRateLimitGuard)
  @ApiOperation({
    summary: 'Refund all or part of a succeeded payment (simulated provider)',
    description:
      'Returns 202 with the refund PENDING; poll GET /v1/refunds/{id} for the outcome. Without an amount, ' +
      'everything still refundable is refunded. Pending and succeeded refunds together never exceed the ' +
      'payment amount. The Idempotency-Key is scoped to refunds: repeating it with the same request ' +
      'replays (200, Idempotent-Replayed: true).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per operation, 1-255 visible ASCII characters (e.g. a UUID)',
  })
  @ApiAcceptedResponse({
    type: RefundResponse,
    description: 'Refund created and queued',
  })
  @ApiOkResponse({ type: RefundResponse, description: 'Idempotent replay' })
  @ApiBadRequestResponse({ type: ErrorResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  @ApiConflictResponse({
    type: ErrorResponse,
    description:
      'Payment not refundable (or not for that amount), or Idempotency-Key reused for another request',
  })
  async create(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CreateRefundRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RefundResponse> {
    try {
      const { refund, replayed } = await this.refunds.create(
        auth.merchantId,
        paymentId,
        idempotencyKey,
        body,
      );
      if (replayed) {
        response.status(HttpStatus.OK);
        response.setHeader('Idempotent-Replayed', 'true');
      }
      return refund;
    } catch (error) {
      if (error instanceof PaymentNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (
        error instanceof IdempotencyKeyReusedError ||
        error instanceof RefundNotAllowedError
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get('payments/:id/refunds')
  @ApiOperation({ summary: "A payment's refunds, oldest first" })
  @ApiOkResponse({ type: [RefundResponse] })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async listForPayment(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) paymentId: string,
  ): Promise<RefundResponse[]> {
    const refunds = await this.refunds.listForPayment(
      auth.merchantId,
      paymentId,
    );
    if (!refunds) throw new NotFoundException('Payment not found');
    return refunds;
  }

  @Get('refunds/:id')
  @ApiOperation({ summary: 'Get a refund owned by the authenticated merchant' })
  @ApiOkResponse({ type: RefundResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async get(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RefundResponse> {
    const refund = await this.refunds.findForMerchant(auth.merchantId, id);
    if (!refund) throw new NotFoundException('Refund not found');
    return refund;
  }
}
