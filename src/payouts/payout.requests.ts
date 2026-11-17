import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PayoutStatus } from '../generated/prisma/enums.js';
import {
  MAX_PAYMENT_AMOUNT,
  SUPPORTED_CURRENCY_CODES,
  type SupportedCurrency,
} from '../payments/currencies.js';
import {
  DEFAULT_PAGE_SIZE,
  IsPaymentCursor,
  MAX_PAGE_SIZE,
} from '../payments/payment.requests.js';

// A simulated bank account: national bank codes and SWIFT BICs, account numbers up to IBAN length.
export class PayoutDestinationRequest {
  @ApiProperty({
    example: '058',
    description: 'Bank code or BIC, 2-11 characters',
  })
  @IsString()
  @Matches(/^[0-9A-Z]{2,11}$/, {
    message: 'bankCode must be 2-11 digits or capital letters',
  })
  bankCode: string;

  @ApiProperty({
    example: '0123456789',
    description: 'Digits or capital letters, 6-34 characters',
  })
  @IsString()
  @Matches(/^[0-9A-Z]{6,34}$/, {
    message: 'accountNumber must be 6-34 digits or capital letters',
  })
  accountNumber: string;

  @ApiProperty({ example: 'Acme Ltd', maxLength: 100 })
  @IsString()
  @Matches(/^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N} .,'&()/-]{1,100}$/u, {
    message:
      "accountName must be 1-100 characters: letters, digits, spaces and . , ' & ( ) / -",
  })
  accountName: string;
}

export class CreatePayoutRequest {
  @ApiProperty({
    example: 200000,
    minimum: 1,
    maximum: MAX_PAYMENT_AMOUNT,
    description:
      'Minor units of the currency; at most the available balance in that currency.',
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

  @ApiProperty({ type: PayoutDestinationRequest })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PayoutDestinationRequest)
  destination: PayoutDestinationRequest;

  @ApiPropertyOptional({
    example: 'settlement_2026_11_17',
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

export class ListPayoutsQuery {
  @ApiPropertyOptional({ enum: PayoutStatus })
  @IsOptional()
  @IsIn(Object.values(PayoutStatus), {
    message: `status must be one of: ${Object.values(PayoutStatus).join(', ')}`,
  })
  status?: PayoutStatus;

  @ApiPropertyOptional({ enum: SUPPORTED_CURRENCY_CODES })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCY_CODES, {
    message: `currency must be one of: ${SUPPORTED_CURRENCY_CODES.join(', ')}`,
  })
  currency?: SupportedCurrency;

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

  @ApiPropertyOptional({ description: 'The nextCursor of the previous page' })
  @IsOptional()
  @IsPaymentCursor()
  cursor?: string;
}
