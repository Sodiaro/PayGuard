import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MerchantEventDeliveryStatus,
  MerchantWebhookDeliveryError,
} from '../generated/prisma/enums.js';
import { MERCHANT_EVENT_TYPES } from './merchant-events.js';

export class WebhookEndpointResponse {
  @ApiProperty({ example: 'https://merchant.example.com/payguard/webhooks' })
  url: string;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty()
  secretRotatedAt: Date;

  @ApiProperty({
    type: Date,
    nullable: true,
    description:
      'Until then deliveries are also signed with the secret replaced by the last rotation',
  })
  previousSecretExpiresAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiPropertyOptional({
    example: 'whsec_3q2-7wE1rX0bVt9kQm4yZp8sLc6nH5dJ0aGfUuIiOo',
    description:
      'The signing secret: returned only when the endpoint is created and when the secret is rotated',
  })
  secret?: string;
}

export class MerchantEventDeliveryResponse {
  @ApiProperty({
    enum: MerchantEventDeliveryStatus,
    nullable: true,
    description: 'null: no endpoint was enabled when the event happened',
  })
  status: MerchantEventDeliveryStatus | null;

  @ApiProperty({ example: 1 })
  attempts: number;

  @ApiProperty({ type: Date, nullable: true })
  lastAttemptAt: Date | null;

  @ApiProperty({ type: Number, nullable: true, example: 200 })
  lastResponseStatus: number | null;

  @ApiProperty({ enum: MerchantWebhookDeliveryError, nullable: true })
  lastError: MerchantWebhookDeliveryError | null;

  @ApiProperty({ type: Date, nullable: true })
  deliveredAt: Date | null;
}

export class MerchantEventResponse {
  @ApiProperty({ format: 'uuid', description: 'Stable across redeliveries' })
  id: string;

  @ApiProperty({ enum: MERCHANT_EVENT_TYPES })
  type: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The payment, refund or payout as the API returned it when the event happened',
  })
  data: unknown;

  @ApiProperty({ type: MerchantEventDeliveryResponse })
  delivery: MerchantEventDeliveryResponse;
}

export class MerchantEventListResponse {
  @ApiProperty({ type: [MerchantEventResponse], description: 'Newest first' })
  data: MerchantEventResponse[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
