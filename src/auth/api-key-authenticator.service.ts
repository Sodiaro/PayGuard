import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { MerchantStatus } from '../generated/prisma/enums.js';
import { hashSecret, parseApiKey, secretMatches } from './api-key.js';
import type { AuthenticatedMerchant } from './authenticated-merchant.js';

export type ApiKeyRejectionReason =
  | 'malformed'
  | 'unknown_prefix'
  | 'invalid_secret'
  | 'revoked'
  | 'expired'
  | 'merchant_suspended';

export type ApiKeyAuthenticationResult =
  | { authenticated: true; merchant: AuthenticatedMerchant }
  | {
      authenticated: false;
      reason: ApiKeyRejectionReason;
      keyPrefix?: string;
    };

const UNKNOWN_KEY_HASH = hashSecret('unknown-key-placeholder');

@Injectable()
export class ApiKeyAuthenticator {
  constructor(private readonly prisma: PrismaService) {}

  async authenticate(
    presentedKey: string,
  ): Promise<ApiKeyAuthenticationResult> {
    const parsed = parseApiKey(presentedKey);
    if (!parsed) {
      return { authenticated: false, reason: 'malformed' };
    }

    const key = await this.prisma.merchantApiKey.findUnique({
      where: { prefix: parsed.prefix },
      select: {
        id: true,
        secretHash: true,
        expiresAt: true,
        revokedAt: true,
        merchant: { select: { id: true, status: true } },
      },
    });

    // Hash and compare even for unknown prefixes so timing does not reveal which prefixes exist.
    const secretValid = secretMatches(
      parsed.secret,
      key?.secretHash ?? UNKNOWN_KEY_HASH,
    );
    const reject = (reason: ApiKeyRejectionReason) =>
      ({ authenticated: false, reason, keyPrefix: parsed.prefix }) as const;

    if (!key) return reject('unknown_prefix');
    if (!secretValid) return reject('invalid_secret');
    if (key.revokedAt) return reject('revoked');
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      return reject('expired');
    }
    if (key.merchant.status !== MerchantStatus.ACTIVE) {
      return reject('merchant_suspended');
    }

    return {
      authenticated: true,
      merchant: { merchantId: key.merchant.id, apiKeyId: key.id },
    };
  }
}
