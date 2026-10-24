import { InvalidMerchantInputError } from './merchant-errors.js';

const SLUG_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_FORMAT.test(value);
}

export function normalizeMerchantName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ');
  if (normalized.length < 1 || normalized.length > 200) {
    throw new InvalidMerchantInputError(
      'Merchant name must be 1-200 characters',
    );
  }
  return normalized;
}

export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

export function validateSlug(slug: string): string {
  if (slug.length < 3 || slug.length > 64 || !SLUG_FORMAT.test(slug)) {
    throw new InvalidMerchantInputError(
      `Invalid slug "${slug}": use 3-64 lowercase letters, digits and single hyphens`,
    );
  }
  return slug;
}

export function validateKeyLabel(label: string | undefined): string | null {
  if (label === undefined) return null;
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new InvalidMerchantInputError('Key label must be 1-100 characters');
  }
  return trimmed;
}

export function validateKeyExpiry(expiresAt: Date | undefined): Date | null {
  if (expiresAt === undefined) return null;
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new InvalidMerchantInputError(
      'Key expiry must be a valid date in the future',
    );
  }
  return expiresAt;
}
