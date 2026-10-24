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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { IdempotencyKey } from './idempotency-key.decorator.js';
import { IdempotencyKeyReusedError } from './payment-errors.js';
import { CreatePaymentRequest } from './payment.requests.js';
import { PaymentResponse } from './payment.responses.js';
import { PaymentsService } from './payments.service.js';

@ApiTags('Payments')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponse })
@ApiTooManyRequestsResponse({
  type: ErrorResponse,
  description: 'Rate limit exceeded; see the Retry-After header',
})
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PaymentCreationRateLimitGuard)
  @ApiOperation({
    summary: 'Create and process a payment (simulated provider)',
    description:
      'The outcome (SUCCEEDED, FAILED, or PENDING when the provider gave no definite answer) is in the body; ' +
      'every outcome is a 201 for a new payment. Repeating the same Idempotency-Key with the same body returns ' +
      'the existing payment (200, Idempotent-Replayed: true) without contacting the provider again.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per payment, 1-255 visible ASCII characters (e.g. a UUID)',
  })
  @ApiCreatedResponse({ type: PaymentResponse, description: 'Payment created' })
  @ApiOkResponse({ type: PaymentResponse, description: 'Idempotent replay' })
  @ApiBadRequestResponse({ type: ErrorResponse })
  @ApiConflictResponse({
    type: ErrorResponse,
    description: 'Idempotency-Key already used with a different request',
  })
  async create(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CreatePaymentRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaymentResponse> {
    try {
      const { payment, replayed } = await this.payments.create(
        auth.merchantId,
        idempotencyKey,
        body,
      );
      if (replayed) {
        response.status(HttpStatus.OK);
        response.setHeader('Idempotent-Replayed', 'true');
      }
      return payment;
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a payment owned by the authenticated merchant',
  })
  @ApiOkResponse({ type: PaymentResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async get(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentResponse> {
    const payment = await this.payments.findForMerchant(auth.merchantId, id);
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }
}
