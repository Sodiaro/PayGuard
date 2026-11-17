import {
  Body,
  ConflictException,
  Controller,
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
import { PaymentResponse } from '../payments/payment.responses.js';
import type { PaymentCommandResult } from '../payments/payments.service.js';
import { PaymentActionNotAllowedError } from './payment-action-errors.js';
import { CapturePaymentRequest } from './payment-action.requests.js';
import { PaymentActionsService } from './payment-actions.service.js';

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
export class PaymentActionsController {
  constructor(private readonly actions: PaymentActionsService) {}

  @Post(':id/capture')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PaymentCreationRateLimitGuard)
  @ApiOperation({
    summary: 'Capture an AUTHORIZED manual-capture payment, fully or in part',
    description:
      'Returns 202 with the payment still AUTHORIZED and a PENDING CAPTURE action; it becomes SUCCEEDED ' +
      'once the provider captures. Without an amount the whole authorization is captured; with one, the ' +
      'rest is released. An authorization is captured once.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER_DOC)
  @ApiAcceptedResponse({ type: PaymentResponse })
  @ApiOkResponse({ type: PaymentResponse, description: 'Idempotent replay' })
  @ApiBadRequestResponse({ type: ErrorResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  @ApiConflictResponse({
    type: ErrorResponse,
    description:
      'Not an authorized manual-capture payment, another capture or void in progress, amount above the ' +
      'authorization, or Idempotency-Key reused for another request',
  })
  capture(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CapturePaymentRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaymentResponse> {
    return respond(response, () =>
      this.actions.capture(auth.merchantId, id, idempotencyKey, body.amount),
    );
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PaymentCreationRateLimitGuard)
  @ApiOperation({
    summary: 'Void an AUTHORIZED manual-capture payment, releasing the funds',
    description:
      'Returns 202 with a PENDING VOID action; the payment becomes CANCELED once the provider voids it.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER_DOC)
  @ApiAcceptedResponse({ type: PaymentResponse })
  @ApiOkResponse({ type: PaymentResponse, description: 'Idempotent replay' })
  @ApiNotFoundResponse({ type: ErrorResponse })
  @ApiConflictResponse({ type: ErrorResponse })
  void(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaymentResponse> {
    return respond(response, () =>
      this.actions.void(auth.merchantId, id, idempotencyKey),
    );
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
      error instanceof PaymentActionNotAllowedError
    ) {
      throw new ConflictException(error.message);
    }
    throw error;
  }
}
