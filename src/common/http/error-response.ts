import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorDetail {
  @ApiProperty({ example: 'amount' })
  field: string;

  @ApiProperty({ example: ['amount must be a positive number'] })
  messages: string[];
}

export class ErrorResponse {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: 'Bad Request' })
  error: string;

  @ApiProperty({ example: 'Validation failed' })
  message: string;

  @ApiPropertyOptional({ type: [ErrorDetail] })
  details?: ErrorDetail[];

  @ApiProperty({ example: '/v1/payments' })
  path: string;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ example: '6f1c1a0e-2b9e-4c1e-9d55-0b2f3c7a9e10' })
  requestId: string;
}
