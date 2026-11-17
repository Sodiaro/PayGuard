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
  Put,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentMerchant } from '../auth/auth.decorators.js';
import type { AuthenticatedMerchant } from '../auth/authenticated-merchant.js';
import { ErrorResponse } from '../common/http/error-response.js';
import { PaymentCreationRateLimitGuard } from '../common/rate-limit/rate-limit.guards.js';
import {
  MerchantEventNotFoundError,
  MerchantEventsService,
  WebhookEndpointUnavailableError,
} from './merchant-events.service.js';
import {
  ListMerchantEventsQuery,
  PutWebhookEndpointRequest,
} from './merchant-webhook.requests.js';
import {
  MerchantEventListResponse,
  MerchantEventResponse,
  WebhookEndpointResponse,
} from './merchant-webhook.responses.js';
import {
  MerchantWebhooksNotConfiguredError,
  WebhookEndpointNotFoundError,
  WebhookEndpointService,
} from './webhook-endpoint.service.js';

@ApiTags('Webhooks (merchant)')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponse })
@Controller()
export class MerchantWebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointService,
    private readonly events: MerchantEventsService,
  ) {}

  @Get('webhook-endpoint')
  @ApiOperation({
    summary: "The merchant's webhook endpoint (never its secret)",
  })
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async getEndpoint(
    @CurrentMerchant() auth: AuthenticatedMerchant,
  ): Promise<WebhookEndpointResponse> {
    const endpoint = await this.endpoints.find(auth.merchantId);
    if (!endpoint)
      throw new NotFoundException('Webhook endpoint not configured');
    return endpoint;
  }

  @Put('webhook-endpoint')
  @ApiOperation({
    summary: 'Create or update the webhook endpoint',
    description:
      'Creating it returns 201 with the signing secret, the only time it is shown. Updating the URL or ' +
      'enabled flag returns 200 without it. The URL must be https and must not point to a private or ' +
      'local address.',
  })
  @ApiCreatedResponse({ type: WebhookEndpointResponse })
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiBadRequestResponse({ type: ErrorResponse })
  @ApiServiceUnavailableResponse({ type: ErrorResponse })
  async putEndpoint(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Body() body: PutWebhookEndpointRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WebhookEndpointResponse> {
    try {
      const { endpoint, created } = await this.endpoints.put(
        auth.merchantId,
        body,
      );
      response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
      return endpoint;
    } catch (error) {
      throw mapEndpointError(error);
    }
  }

  @Post('webhook-endpoint/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace the signing secret',
    description:
      'Returns the new secret once. For 24 hours deliveries carry signatures with both the new and the ' +
      'previous secret, so the new one can be deployed without rejecting deliveries.',
  })
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  @ApiServiceUnavailableResponse({ type: ErrorResponse })
  async rotateSecret(
    @CurrentMerchant() auth: AuthenticatedMerchant,
  ): Promise<WebhookEndpointResponse> {
    try {
      return await this.endpoints.rotateSecret(auth.merchantId);
    } catch (error) {
      throw mapEndpointError(error);
    }
  }

  @Get('events')
  @ApiOperation({
    summary: "The merchant's events, newest first, with their delivery state",
  })
  @ApiOkResponse({ type: MerchantEventListResponse })
  @ApiBadRequestResponse({ type: ErrorResponse })
  listEvents(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Query() query: ListMerchantEventsQuery,
  ): Promise<MerchantEventListResponse> {
    return this.events.list(auth.merchantId, query);
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'One event and its delivery state' })
  @ApiOkResponse({ type: MerchantEventResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async getEvent(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MerchantEventResponse> {
    const event = await this.events.find(auth.merchantId, id);
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  @Post('events/:id/redeliver')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PaymentCreationRateLimitGuard)
  @ApiOperation({
    summary: 'Queue the event for delivery again',
    description:
      'Sends it to the endpoint as configured now, with a fresh retry budget. A delivery already queued ' +
      'is left as it is. The event ID stays the same, so receivers deduplicate as usual.',
  })
  @ApiAcceptedResponse({ type: MerchantEventResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  @ApiConflictResponse({ type: ErrorResponse })
  async redeliver(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MerchantEventResponse> {
    try {
      return await this.events.redeliver(auth.merchantId, id);
    } catch (error) {
      if (error instanceof MerchantEventNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof WebhookEndpointUnavailableError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}

function mapEndpointError(error: unknown): unknown {
  if (error instanceof WebhookEndpointNotFoundError) {
    return new NotFoundException(error.message);
  }
  if (error instanceof MerchantWebhooksNotConfiguredError) {
    return new ServiceUnavailableException(error.message);
  }
  return error;
}
