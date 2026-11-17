import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { MAX_PAYMENT_AMOUNT } from '../payments/currencies.js';

// The currency is the payment's and the charge comes from PayGuard's records; neither is accepted.
export class CreateRefundRequest {
  @ApiPropertyOptional({
    example: 150000,
    minimum: 1,
    maximum: MAX_PAYMENT_AMOUNT,
    description:
      "Minor units of the payment's currency. Omitted: everything still refundable.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAYMENT_AMOUNT)
  amount?: number;

  @ApiPropertyOptional({
    example: 'return_552',
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
