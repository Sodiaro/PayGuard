import { ApiProperty } from '@nestjs/swagger';
import { PayoutFailureCode, PayoutStatus } from '../generated/prisma/enums.js';
import { SUPPORTED_CURRENCY_CODES } from '../payments/currencies.js';

export class PayoutDestinationResponse {
  @ApiProperty({ example: '058' })
  bankCode: string;

  @ApiProperty({
    example: '6789',
    description: 'The full account number is never returned',
  })
  accountNumberLast4: string;

  @ApiProperty({ example: 'Acme Ltd' })
  accountName: string;
}

export class PayoutResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 200000, description: 'Minor units of the currency' })
  amount: number;

  @ApiProperty({ enum: SUPPORTED_CURRENCY_CODES, example: 'NGN' })
  currency: string;

  @ApiProperty({
    enum: PayoutStatus,
    description:
      'PENDING means the outcome is not known yet; the amount stays out of the available balance until the payout fails.',
  })
  status: PayoutStatus;

  @ApiProperty({ type: PayoutDestinationResponse })
  destination: PayoutDestinationResponse;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'settlement_2026_11_17',
  })
  reference: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'simpo_3f9c2a7d1b4e6f80aa12bc34',
  })
  providerReference: string | null;

  @ApiProperty({ enum: PayoutFailureCode, nullable: true })
  failureCode: PayoutFailureCode | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  completedAt: Date | null;
}

export class PayoutListResponse {
  @ApiProperty({ type: [PayoutResponse], description: 'Newest first' })
  data: PayoutResponse[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class CurrencyBalanceResponse {
  @ApiProperty({ enum: SUPPORTED_CURRENCY_CODES, example: 'NGN' })
  currency: string;

  @ApiProperty({
    example: 350000,
    description:
      'What can be paid out now: captured - refunded - paidOut - inTransit. Negative after refunds exceed what is left.',
  })
  available: number;

  @ApiProperty({
    example: 500000,
    description: 'Captured by succeeded payments',
  })
  captured: number;

  @ApiProperty({ example: 50000, description: 'Pending and succeeded refunds' })
  refunded: number;

  @ApiProperty({ example: 0, description: 'Succeeded payouts' })
  paidOut: number;

  @ApiProperty({ example: 100000, description: 'Pending payouts' })
  inTransit: number;
}

export class BalanceResponse {
  @ApiProperty({
    type: [CurrencyBalanceResponse],
    description: 'One entry per currency with any activity, by currency code',
  })
  balances: CurrencyBalanceResponse[];
}
