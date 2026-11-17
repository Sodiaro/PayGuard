import { ApiProperty } from '@nestjs/swagger';
import {
  CaptureMethod,
  PaymentActionFailureCode,
  PaymentActionStatus,
  PaymentActionType,
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

export class PaymentActionResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: PaymentActionType })
  type: PaymentActionType;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 400000,
    description: 'Captures only: the amount captured',
  })
  amount: number | null;

  @ApiProperty({
    enum: PaymentActionStatus,
    description: 'PENDING means the outcome is not known yet.',
  })
  status: PaymentActionStatus;

  @ApiProperty({ type: String, nullable: true })
  providerReference: string | null;

  @ApiProperty({ enum: PaymentActionFailureCode, nullable: true })
  failureCode: PaymentActionFailureCode | null;

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

  @ApiProperty({
    enum: PaymentStatus,
    description:
      'AUTHORIZED and CANCELED occur only with manual capture: authorized and awaiting capture, or voided.',
  })
  status: PaymentStatus;

  @ApiProperty({ enum: CaptureMethod })
  captureMethod: CaptureMethod;

  @ApiProperty({ type: String, nullable: true, example: 'order_10042' })
  reference: string | null;

  @ApiProperty({
    enum: PaymentFailureCode,
    nullable: true,
    description: "The latest attempt's failure code when the payment FAILED",
  })
  failureCode: PaymentFailureCode | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 500000,
    description:
      'Minor units charged once the payment SUCCEEDED: the amount, or with manual capture the captured amount',
  })
  amountCaptured: number | null;

  @ApiProperty({
    example: 0,
    description:
      'Minor units returned by succeeded refunds; pending refunds are not included',
  })
  amountRefunded: number;

  @ApiProperty({ type: [PaymentAttemptResponse] })
  attempts: PaymentAttemptResponse[];

  @ApiProperty({
    type: [PaymentActionResponse],
    description: 'Captures and voids of a manual-capture payment, oldest first',
  })
  actions: PaymentActionResponse[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class PaymentListResponse {
  @ApiProperty({ type: [PaymentResponse], description: 'Newest first' })
  data: PaymentResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as cursor to read the next page; null on the last page',
  })
  nextCursor: string | null;
}
