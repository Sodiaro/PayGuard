import { ApiProperty } from '@nestjs/swagger';
import { MerchantStatus } from '../generated/prisma/enums.js';
import type { ApiKeySummary } from './api-keys.service.js';
import type { MerchantProfile } from './merchants.service.js';

export class MerchantResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'acme-ltd' })
  slug: string;

  @ApiProperty({ example: 'Acme Ltd' })
  name: string;

  @ApiProperty({ enum: MerchantStatus })
  status: MerchantStatus;

  @ApiProperty()
  createdAt: Date;

  static from(merchant: MerchantProfile): MerchantResponse {
    const { id, slug, name, status, createdAt } = merchant;
    return { id, slug, name, status, createdAt };
  }
}

export class ApiKeyResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'pgsk_3f9c2a7d1b4e6f80',
    description:
      'Public identifier; the secret is never returned after issuance',
  })
  prefix: string;

  @ApiProperty({ type: String, nullable: true, example: 'production' })
  label: string | null;

  @ApiProperty({ enum: ['active', 'revoked', 'expired'] })
  status: ApiKeySummary['status'];

  @ApiProperty({ type: Date, nullable: true })
  expiresAt: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  revokedAt: Date | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    description:
      'Approximate: updated at most once every 15 minutes per API instance',
  })
  lastUsedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  static from(key: ApiKeySummary): ApiKeyResponse {
    const {
      id,
      prefix,
      label,
      status,
      expiresAt,
      revokedAt,
      lastUsedAt,
      createdAt,
    } = key;
    return {
      id,
      prefix,
      label,
      status,
      expiresAt,
      revokedAt,
      lastUsedAt,
      createdAt,
    };
  }
}
