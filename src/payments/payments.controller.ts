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
import { IdempotencyKey } from './idempotency-key.decorator.js';
import {
  IdempotencyKeyReusedError,
  PaymentNotFoundError,
  PaymentNotRetryableError,
} from './payment-errors.js';
import { CreatePaymentRequest } from './payment.requests.js';
import { PaymentResponse } from './payment.responses.js';
import {
  PaymentsService,
  type PaymentCommandResult,
} from './payments.service.js';

const IDEMPOTENCY_KEY_HEADER_DOC = {
  name: 'Idempotency-Key',
  required: true,
  description:
    'Unique per operation, 1-255 visible ASCII characters (e.g. a UUID)',
};

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
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PaymentCreationRateLimitGuard)
  @ApiOperation({
    summary:
      'Create a payment and queue it for processing (simulated provider)',
    description:
      'Returns 202 with the payment PENDING; poll GET /v1/payments/{id} for the outcome. Repeating the same ' +
      'Idempotency-Key with the same body returns the existing payment (200, Idempotent-Replayed: true) ' +
      'without queuing more work.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER_DOC)
  @ApiAcceptedResponse({
    type: PaymentResponse,
    description: 'Payment created and queued',
  })
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
    return respond(response, () =>
      this.payments.create(auth.merchantId, idempotencyKey, body),
    );
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PaymentCreationRateLimitGuard)
  @ApiOperation({
    summary: 'Retry a failed payment with a new attempt',
    description:
      'Allowed only for a FAILED payment whose latest attempt failed with a retryable code and that has ' +
      'attempts left. Returns 202 with the payment PENDING again. The Idempotency-Key is scoped to retries: ' +
      'repeating it for the same payment replays (200); using it for another payment returns 409.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER_DOC)
  @ApiAcceptedResponse({ type: PaymentResponse, description: 'Retry queued' })
  @ApiOkResponse({ type: PaymentResponse, description: 'Idempotent replay' })
  @ApiNotFoundResponse({ type: ErrorResponse })
  @ApiConflictResponse({
    type: ErrorResponse,
    description:
      'Payment not retryable, or Idempotency-Key reused for another request',
  })
  async retry(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaymentResponse> {
    return respond(response, () =>
      this.payments.retry(auth.merchantId, id, idempotencyKey),
    );
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

async function respond(
  response: Response,
  command: () => Promise<PaymentCommandResult>,
): Promise<PaymentResponse> {
  try {
    const { payment, replayed } = await command();
    if (replayed) {
      response.status(HttpStatus.OK);
      response.setHeader('Idempotent-Replayed', 'true');
    }
    return payment;
  } catch (error) {
    if (error instanceof PaymentNotFoundError) {
      throw new NotFoundException(error.message);
    }
    if (
      error instanceof IdempotencyKeyReusedError ||
      error instanceof PaymentNotRetryableError
    ) {
      throw new ConflictException(error.message);
    }
    throw error;
  }
}
