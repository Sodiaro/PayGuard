import { Injectable } from '@nestjs/common';
import { recordAuditEvent, SYSTEM_ACTOR } from '../audit/operator-audit.js';
import { displayPrefix, generateApiKey } from '../auth/api-key.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ApiKeyNotFoundError } from './merchant-errors.js';
import {
  isUuid,
  validateKeyExpiry,
  validateKeyLabel,
} from './merchant-input.js';

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

export interface ApiKeySummary {
  id: string;
  merchantId: string;
  prefix: string;
  label: string | null;
  status: ApiKeyStatus;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface IssuedApiKey extends ApiKeySummary {
  // Returned only from issuance; it is never stored and cannot be retrieved later.
  plaintext: string;
}

export interface IssueApiKeyOptions {
  label?: string;
  expiresAt?: Date;
}

const SUMMARY_FIELDS = {
  id: true,
  merchantId: true,
  prefix: true,
  label: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdAt: true,
} satisfies Prisma.MerchantApiKeySelect;

type ApiKeyRow = Prisma.MerchantApiKeyGetPayload<{
  select: typeof SUMMARY_FIELDS;
}>;

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(
    merchantId: string,
    options: IssueApiKeyOptions = {},
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<IssuedApiKey> {
    const label = validateKeyLabel(options.label);
    const expiresAt = validateKeyExpiry(options.expiresAt);
    const key = generateApiKey();

    const row = await db.merchantApiKey.create({
      data: {
        merchantId,
        prefix: key.prefix,
        secretHash: key.secretHash,
        label,
        expiresAt,
      },
      select: SUMMARY_FIELDS,
    });
    return { ...toSummary(row), plaintext: key.plaintext };
  }

  // Idempotent: revoking an already revoked key keeps the original revocation time and writes no
  // second audit record.
  async revoke(
    reference: string,
    actor = SYSTEM_ACTOR,
  ): Promise<ApiKeySummary> {
    const where = keyWhere(reference);
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.merchantApiKey.updateMany({
        where: { ...where, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const row = await tx.merchantApiKey.findFirst({
        where,
        select: SUMMARY_FIELDS,
      });
      if (!row) throw new ApiKeyNotFoundError(reference);
      if (revoked.count === 1) {
        await recordAuditEvent(tx, {
          actor,
          action: 'api_key.revoked',
          targetType: 'api_key',
          targetId: row.id,
          details: {
            merchantId: row.merchantId,
            prefix: displayPrefix(row.prefix),
          },
        });
      }
      return toSummary(row);
    });
  }

  async listForMerchant(merchantId: string): Promise<ApiKeySummary[]> {
    const rows = await this.prisma.merchantApiKey.findMany({
      where: { merchantId },
      select: SUMMARY_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toSummary);
  }

  // Scoped by merchant: another merchant's key is indistinguishable from a missing one.
  async findForMerchant(
    merchantId: string,
    keyId: string,
  ): Promise<ApiKeySummary | null> {
    const row = await this.prisma.merchantApiKey.findFirst({
      where: { id: keyId, merchantId },
      select: SUMMARY_FIELDS,
    });
    return row && toSummary(row);
  }
}

function keyWhere(reference: string): Prisma.MerchantApiKeyWhereInput {
  if (isUuid(reference)) return { id: reference };
  return { prefix: reference.replace(/^pgsk_/, '') };
}

function toSummary(row: ApiKeyRow): ApiKeySummary {
  return {
    ...row,
    prefix: displayPrefix(row.prefix),
    status: statusOf(row),
  };
}

function statusOf(row: ApiKeyRow): ApiKeyStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'active';
}
