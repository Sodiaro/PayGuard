import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAYMENT_AMOUNT } from '../payments/currencies.js';

export class CapturePaymentRequest {
  @ApiPropertyOptional({
    example: 400000,
    minimum: 1,
    maximum: MAX_PAYMENT_AMOUNT,
    description:
      'Minor units, at most the authorized amount; the rest is released. Omitted: the whole authorization.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAYMENT_AMOUNT)
  amount?: number;
}
