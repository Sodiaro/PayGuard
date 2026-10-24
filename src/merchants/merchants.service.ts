import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { MerchantStatus } from '../generated/prisma/enums.js';
import {
  ApiKeysService,
  type IssueApiKeyOptions,
  type IssuedApiKey,
} from './api-keys.service.js';
import {
  MerchantAlreadyExistsError,
  MerchantNotFoundError,
} from './merchant-errors.js';
import {
  isUuid,
  normalizeMerchantName,
  slugFromName,
  validateSlug,
} from './merchant-input.js';

export interface MerchantProfile {
  id: string;
  slug: string;
  name: string;
  status: MerchantStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProvisionMerchantInput {
  name: string;
  slug?: string;
  firstKey?: IssueApiKeyOptions;
}

const PROFILE_FIELDS = {
  id: true,
  slug: true,
  name: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MerchantSelect;

@Injectable()
export class MerchantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  // Merchant and first key are created atomically; a retry or concurrent duplicate
  // hits the unique slug, rolls back, and never issues a second key.
  async provision(
    input: ProvisionMerchantInput,
  ): Promise<{ merchant: MerchantProfile; apiKey: IssuedApiKey }> {
    const name = normalizeMerchantName(input.name);
    const slug = validateSlug(input.slug ?? slugFromName(name));

    try {
      return await this.prisma.$transaction(async (tx) => {
        const merchant = await tx.merchant.create({
          data: { name, slug },
          select: PROFILE_FIELDS,
        });
        const apiKey = await this.apiKeys.issue(
          merchant.id,
          input.firstKey,
          tx,
        );
        return { merchant, apiKey };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new MerchantAlreadyExistsError(slug);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<MerchantProfile | null> {
    return this.prisma.merchant.findUnique({
      where: { id },
      select: PROFILE_FIELDS,
    });
  }

  async resolve(reference: string): Promise<MerchantProfile> {
    const merchant = await this.prisma.merchant.findUnique({
      where: isUuid(reference) ? { id: reference } : { slug: reference },
      select: PROFILE_FIELDS,
    });
    if (!merchant) throw new MerchantNotFoundError(reference);
    return merchant;
  }

  async list(): Promise<MerchantProfile[]> {
    return this.prisma.merchant.findMany({
      select: PROFILE_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }

  async setStatus(
    reference: string,
    status: MerchantStatus,
  ): Promise<MerchantProfile> {
    const merchant = await this.resolve(reference);
    if (merchant.status === status) return merchant;
    return this.prisma.merchant.update({
      where: { id: merchant.id },
      data: { status },
      select: PROFILE_FIELDS,
    });
  }

  async issueKey(
    reference: string,
    options: IssueApiKeyOptions,
  ): Promise<{ merchant: MerchantProfile; apiKey: IssuedApiKey }> {
    const merchant = await this.resolve(reference);
    return { merchant, apiKey: await this.apiKeys.issue(merchant.id, options) };
  }
}
