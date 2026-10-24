import type { Request } from 'express';

export interface AuthenticatedMerchant {
  merchantId: string;
  apiKeyId: string;
}

export type AuthenticatedRequest = Request & {
  merchant?: AuthenticatedMerchant;
};
