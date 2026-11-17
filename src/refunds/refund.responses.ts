import { ApiProperty } from '@nestjs/swagger';
import { RefundFailureCode, RefundStatus } from '../generated/prisma/enums.js';
import { SUPPORTED_CURRENCY_CODES } from '../payments/currencies.js';

export class RefundResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  paymentId: string;

  @ApiProperty({ example: 150000, description: 'Minor units of the currency' })
  amount: number;

  @ApiProperty({ enum: SUPPORTED_CURRENCY_CODES, example: 'NGN' })
  currency: string;

  @ApiProperty({
    enum: RefundStatus,
    description: 'PENDING means the outcome is not known yet.',
  })
  status: RefundStatus;

  @ApiProperty({ type: String, nullable: true, example: 'return_552' })
  reference: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'simrf_3f9c2a7d1b4e6f80aa12bc34',
  })
  providerReference: string | null;

  @ApiProperty({ enum: RefundFailureCode, nullable: true })
  failureCode: RefundFailureCode | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  completedAt: Date | null;
}
