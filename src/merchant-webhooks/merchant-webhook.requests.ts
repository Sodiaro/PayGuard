import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DEFAULT_PAGE_SIZE,
  IsPaymentCursor,
  MAX_PAGE_SIZE,
} from '../payments/payment.requests.js';
import {
  MERCHANT_EVENT_TYPES,
  type MerchantEventType,
} from './merchant-events.js';
import { MAX_WEBHOOK_URL_LENGTH } from './webhook-targets.js';

// The URL's target policy (https, no private addresses) depends on configuration, so the service
// checks it; this only checks the shape.
export class PutWebhookEndpointRequest {
  @ApiProperty({ example: 'https://merchant.example.com/payguard/webhooks' })
  @IsString()
  @MaxLength(MAX_WEBHOOK_URL_LENGTH)
  url: string;

  @ApiPropertyOptional({
    default: true,
    description: 'false stops new deliveries; events are still recorded',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ListMerchantEventsQuery {
  @ApiPropertyOptional({ enum: MERCHANT_EVENT_TYPES })
  @IsOptional()
  @IsIn(MERCHANT_EVENT_TYPES, {
    message: `type must be one of: ${MERCHANT_EVENT_TYPES.join(', ')}`,
  })
  type?: MerchantEventType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  paymentId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ description: 'The nextCursor of the previous page' })
  @IsOptional()
  @IsPaymentCursor()
  cursor?: string;
}
