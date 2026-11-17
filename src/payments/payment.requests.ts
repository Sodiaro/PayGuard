import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';
import { PaymentStatus } from '../generated/prisma/enums.js';
import {
  MAX_PAYMENT_AMOUNT,
  SUPPORTED_CURRENCY_CODES,
  type SupportedCurrency,
} from './currencies.js';
import { decodePaymentCursor } from './payment-cursor.js';

const REFERENCE_FORMAT = /^[A-Za-z0-9._:/#-]{1,64}$/;
const REFERENCE_MESSAGE =
  'reference must be 1-64 characters: letters, digits and . _ : / # -';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Merchant identity, status and provider data are server-owned; the global ValidationPipe
// rejects any undeclared field.
export class CreatePaymentRequest {
  @ApiProperty({
    example: 500000,
    minimum: 1,
    maximum: MAX_PAYMENT_AMOUNT,
    description:
      'Integer amount in the minor unit of the currency (e.g. 500000 NGN = 5,000.00 naira; 500 JPY = 500 yen).',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_PAYMENT_AMOUNT)
  amount: number;

  @ApiProperty({ enum: SUPPORTED_CURRENCY_CODES, example: 'NGN' })
  @IsString()
  @IsIn(SUPPORTED_CURRENCY_CODES, {
    message: `currency must be one of: ${SUPPORTED_CURRENCY_CODES.join(', ')}`,
  })
  currency: SupportedCurrency;

  @ApiPropertyOptional({
    example: 'order_10042',
    description:
      "The merchant's own reference, returned as-is. Not unique and not used for idempotency.",
  })
  @IsOptional()
  @IsString()
  @Matches(REFERENCE_FORMAT, { message: REFERENCE_MESSAGE })
  reference?: string;
}

// The cursor format is shared by every keyset listing on (createdAt, id).
export function IsPaymentCursor(): PropertyDecorator {
  return ValidateBy({
    name: 'isPaymentCursor',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && decodePaymentCursor(value) !== null,
      defaultMessage: () => 'cursor must be a nextCursor value from a listing',
    },
  });
}

// Query strings arrive as strings; a repeated parameter arrives as an array and fails validation.
export class ListPaymentsQuery {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsIn(Object.values(PaymentStatus), {
    message: `status must be one of: ${Object.values(PaymentStatus).join(', ')}`,
  })
  status?: PaymentStatus;

  @ApiPropertyOptional({ example: 'order_10042' })
  @IsOptional()
  @IsString()
  @Matches(REFERENCE_FORMAT, { message: REFERENCE_MESSAGE })
  reference?: string;

  @ApiPropertyOptional({
    example: '2026-10-01T00:00:00.000Z',
    description: 'Only payments created at or after this time (ISO 8601)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  createdFrom?: string;

  @ApiPropertyOptional({
    example: '2026-11-01T00:00:00.000Z',
    description: 'Only payments created before this time (ISO 8601)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  createdTo?: string;

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

  @ApiPropertyOptional({
    description: 'The nextCursor of the previous page',
  })
  @IsOptional()
  @IsPaymentCursor()
  cursor?: string;
}
