import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type {
  AuthenticatedMerchant,
  AuthenticatedRequest,
} from './authenticated-merchant.js';

export const IS_PUBLIC_ROUTE = 'payguard:isPublicRoute';

export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);

// The only supported source of merchant identity in controllers; never read a merchant ID from the request.
export const CurrentMerchant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedMerchant => {
    const merchant = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().merchant;
    if (!merchant) {
      throw new Error(
        '@CurrentMerchant() used on a route that is not API-key authenticated',
      );
    }
    return merchant;
  },
);
