import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { createHash } from 'node:crypto';
import {
  MAX_PAYMENT_AMOUNT,
  SUPPORTED_CURRENCY_CODES,
  type SupportedCurrency,
} from '../payments/currencies.js';

export const PROVIDER_WEBHOOK_EVENT_TYPES = [
  'payment.succeeded',
  'payment.declined',
  'payment.processing',
] as const;

export type ProviderWebhookEventType =
  (typeof PROVIDER_WEBHOOK_EVENT_TYPES)[number];

const UUID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP_FORMAT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// Identifies the attempt the provider processed. No payment ID, merchant ID or status is accepted:
// the attempt is resolved from PayGuard's own records, and amount and currency are only compared.
export class ProviderWebhookEventData {
  // The idempotency reference PayGuard sent with the submission.
  @IsString()
  @Matches(UUID_FORMAT, { message: 'attemptId must be a lowercase UUID' })
  attemptId: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,100}$/, {
    message: 'providerReference must be 1-100 of A-Z a-z 0-9 _ -',
  })
  providerReference: string;

  @IsInt()
  @Min(1)
  @Max(MAX_PAYMENT_AMOUNT)
  amount: number;

  @IsString()
  @IsIn(SUPPORTED_CURRENCY_CODES)
  currency: SupportedCurrency;
}

export class ProviderWebhookEvent {
  @IsString()
  @Matches(/^evt_[A-Za-z0-9]{8,64}$/, {
    message: 'id must be evt_ followed by 8-64 letters or digits',
  })
  id: string;

  @IsString()
  @IsIn(PROVIDER_WEBHOOK_EVENT_TYPES, {
    message: `type must be one of: ${PROVIDER_WEBHOOK_EVENT_TYPES.join(', ')}`,
  })
  type: ProviderWebhookEventType;

  @IsString()
  @Matches(UTC_TIMESTAMP_FORMAT, {
    message: 'createdAt must be an ISO 8601 UTC timestamp',
  })
  @IsISO8601({ strict: true })
  createdAt: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ProviderWebhookEventData)
  data: ProviderWebhookEventData;
}

// Identifies the event's meaning, not its bytes, so a redelivery serialized differently (key order,
// whitespace, timestamp precision) is still recognised as the same event. Stored per event: any
// change to this canonical form must bump the version tag.
export function fingerprintWebhookEvent(event: ProviderWebhookEvent): string {
  const canonical = JSON.stringify([
    'webhooks.event.v1',
    event.id,
    event.type,
    new Date(event.createdAt).toISOString(),
    event.data.attemptId,
    event.data.providerReference,
    event.data.amount,
    event.data.currency,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
