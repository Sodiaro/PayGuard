import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { ErrorResponse } from '../common/http/error-response.js';
import { createValidationPipe } from '../common/http/validation.js';
import type { ApiEnvironment } from '../config/environment.js';
import { SIMULATOR_SIGNATURE_HEADER } from '../payments/providers/simulated-webhooks.js';
import { ProviderWebhookInbox } from './provider-webhook-inbox.js';
import { ProviderWebhookEvent } from './provider-webhook.requests.js';
import { verifyWebhookSignature } from './webhook-signature.js';

const SIMULATOR_PROVIDER = 'simulator';

export class WebhookReceipt {
  @ApiProperty({ enum: ['accepted', 'duplicate'] })
  status: 'accepted' | 'duplicate';
}

// Unauthenticated by API key: the provider authenticates with a signature over the raw body.
// Responses carry no payment data, and rejections give the sender only a generic reason.
@ApiTags('Provider webhooks')
@Public()
@Controller('webhooks')
export class ProviderWebhooksController {
  private readonly logger = new Logger(ProviderWebhooksController.name);
  private readonly simulatorSecret?: string;
  private readonly toleranceSeconds: number;
  private readonly validation = createValidationPipe();

  constructor(
    private readonly inbox: ProviderWebhookInbox,
    config: ConfigService<ApiEnvironment, true>,
  ) {
    this.simulatorSecret = config.get('SIMULATOR_WEBHOOK_SECRET', {
      infer: true,
    });
    this.toleranceSeconds = config.get('WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS', {
      infer: true,
    });
    if (!this.simulatorSecret) {
      this.logger.warn(
        'SIMULATOR_WEBHOOK_SECRET is not set; simulator webhooks are rejected',
      );
    }
  }

  @Post('simulator')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Receive a signed event from the simulated payment provider',
    description:
      'For the provider, not merchants. The body is verified against the X-Simulator-Signature header, ' +
      'stored, and applied asynchronously. 202 means stored and queued, 200 a repeated delivery of a stored ' +
      'event; both tell the provider to stop retrying.',
  })
  @ApiHeader({
    name: 'X-Simulator-Signature',
    required: true,
    description: 't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>." + raw body>',
  })
  @ApiAcceptedResponse({ type: WebhookReceipt })
  @ApiOkResponse({ type: WebhookReceipt, description: 'Duplicate delivery' })
  @ApiBadRequestResponse({ type: ErrorResponse })
  @ApiUnauthorizedResponse({ type: ErrorResponse })
  @ApiConflictResponse({
    type: ErrorResponse,
    description: 'Event ID already received with different content',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponse,
    description: 'Not configured, or the event could not be stored; retry',
  })
  async receiveSimulatorEvent(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WebhookReceipt> {
    const secret = this.simulatorSecret;
    if (!secret) {
      this.reject('not_configured');
      throw new ServiceUnavailableException('Webhooks are not configured');
    }
    if (!request.is('application/json')) {
      this.reject('unsupported_content_type');
      throw new UnsupportedMediaTypeException(
        'Content-Type must be application/json',
      );
    }
    const rawBody: unknown = request.body;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      this.reject('empty_body');
      throw new BadRequestException('Request body is required');
    }

    const signature = verifyWebhookSignature({
      secret,
      header: request.headers[SIMULATOR_SIGNATURE_HEADER],
      rawBody,
      nowSeconds: Math.floor(Date.now() / 1000),
      toleranceSeconds: this.toleranceSeconds,
    });
    if (!signature.valid) {
      this.reject(`signature_${signature.reason}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // Only authenticated bytes are parsed.
    const event = await this.parseEvent(rawBody);

    let accepted: Awaited<ReturnType<ProviderWebhookInbox['accept']>>;
    try {
      accepted = await this.inbox.accept(
        SIMULATOR_PROVIDER,
        event,
        new Date(signature.timestamp * 1000),
      );
    } catch (error) {
      this.logger.error(
        'Webhook event could not be stored; the provider should retry',
        error instanceof Error ? error.stack : String(error),
        { provider: SIMULATOR_PROVIDER, eventId: event.id },
      );
      throw new ServiceUnavailableException(
        'Webhook could not be stored; retry later',
      );
    }

    const logFields = {
      provider: SIMULATOR_PROVIDER,
      eventId: event.id,
      eventType: event.type,
      attemptId: event.data.attemptId,
    };
    switch (accepted.acceptance) {
      case 'accepted':
        this.logger.log(
          accepted.unknownAttempt
            ? 'Webhook event recorded for an unknown attempt; nothing to apply'
            : 'Webhook event accepted',
          logFields,
        );
        return { status: 'accepted' };
      case 'duplicate':
        this.logger.log('Duplicate webhook delivery', logFields);
        response.status(HttpStatus.OK);
        return { status: 'duplicate' };
      case 'payload_conflict':
        this.logger.error(
          'Webhook event ID reused with different content; delivery rejected',
          logFields,
        );
        throw new ConflictException(
          'Event ID was already received with different content',
        );
    }
  }

  private async parseEvent(rawBody: Buffer): Promise<ProviderWebhookEvent> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(rawBody),
      );
    } catch {
      this.reject('invalid_json');
      throw new BadRequestException('Webhook body must be valid UTF-8 JSON');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      this.reject('invalid_payload');
      throw new BadRequestException('Webhook body must be a JSON object');
    }
    try {
      return (await this.validation.transform(parsed, {
        type: 'body',
        metatype: ProviderWebhookEvent,
      })) as ProviderWebhookEvent;
    } catch (error) {
      this.reject('invalid_payload');
      throw error;
    }
  }

  // Reasons are fixed codes; nothing from the request is logged before it is authenticated.
  private reject(reason: string): void {
    this.logger.warn('Webhook rejected', {
      provider: SIMULATOR_PROVIDER,
      reason,
    });
  }
}
