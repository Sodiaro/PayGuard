import { ApiProperty } from '@nestjs/swagger';
import {
  PaymentAttemptStatus,
  PaymentFailureCode,
  PaymentStatus,
} from '../generated/prisma/enums.js';
import { SUPPORTED_CURRENCY_CODES } from './currencies.js';

export class PaymentAttemptResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 1 })
  attemptNumber: number;

  @ApiProperty({ example: 'simulator' })
  provider: string;

  @ApiProperty({
    enum: PaymentAttemptStatus,
    description: 'PENDING means the outcome is not known yet.',
  })
  status: PaymentAttemptStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'sim_3f9c2a7d1b4e6f80aa12bc34',
  })
  providerReference: string | null;

  @ApiProperty({ enum: PaymentFailureCode, nullable: true })
  failureCode: PaymentFailureCode | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  completedAt: Date | null;
}

export class PaymentResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 500000, description: 'Minor units of the currency' })
  amount: number;

  @ApiProperty({ enum: SUPPORTED_CURRENCY_CODES, example: 'NGN' })
  currency: string;

  @ApiProperty({ enum: PaymentStatus })
  status: PaymentStatus;

  @ApiProperty({ type: String, nullable: true, example: 'order_10042' })
  reference: string | null;

  @ApiProperty({
    enum: PaymentFailureCode,
    nullable: true,
    description: "The latest attempt's failure code when the payment FAILED",
  })
  failureCode: PaymentFailureCode | null;

  @ApiProperty({ type: [PaymentAttemptResponse] })
  attempts: PaymentAttemptResponse[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
