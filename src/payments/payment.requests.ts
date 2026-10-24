import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  MAX_PAYMENT_AMOUNT,
  SUPPORTED_CURRENCY_CODES,
  type SupportedCurrency,
} from './currencies.js';

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
  @Matches(/^[A-Za-z0-9._:/#-]{1,64}$/, {
    message:
      'reference must be 1-64 characters: letters, digits and . _ : / # -',
  })
  reference?: string;
}
