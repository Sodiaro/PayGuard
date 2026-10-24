import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { requestContext } from '../common/logging/request-context.js';
import {
  ApiKeyAuthenticator,
  type ApiKeyAuthenticationResult,
} from './api-key-authenticator.service.js';
import { IS_PUBLIC_ROUTE } from './auth.decorators.js';
import type { AuthenticatedRequest } from './authenticated-merchant.js';

const BEARER = /^Bearer[ ]+(\S+)$/i;

// Registered as a global guard: every route requires an API key unless marked @Public().
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: ApiKeyAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_ROUTE,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const authorization = request.headers.authorization;
    if (!authorization) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="PayGuard"');
      throw new UnauthorizedException('Missing API key');
    }

    const presentedKey = BEARER.exec(authorization)?.[1];
    const result: ApiKeyAuthenticationResult = presentedKey
      ? await this.authenticator.authenticate(presentedKey)
      : { authenticated: false, reason: 'malformed' };

    if (!result.authenticated) {
      // Every rejection looks identical to the client; the reason is for operators only.
      this.logger.warn('API key rejected', {
        reason: result.reason,
        keyPrefix: result.keyPrefix,
      });
      response.setHeader(
        'WWW-Authenticate',
        'Bearer realm="PayGuard", error="invalid_token"',
      );
      throw new UnauthorizedException('Invalid API key');
    }

    request.merchant = result.merchant;
    const store = requestContext.getStore();
    if (store) {
      store.merchantId = result.merchant.merchantId;
    }
    return true;
  }
}
