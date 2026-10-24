import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ExecutionContext,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { requestContext } from '../common/logging/request-context.js';
import type {
  ApiKeyAuthenticationResult,
  ApiKeyAuthenticator,
} from './api-key-authenticator.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import type { AuthenticatedRequest } from './authenticated-merchant.js';

const VALID_LOOKING_KEY = 'pgsk_0123456789abcdef_' + 'a'.repeat(43);

function setup(options: {
  isPublic?: boolean;
  authorization?: string;
  result?: ApiKeyAuthenticationResult;
}) {
  const request = {
    headers: { authorization: options.authorization },
  } as unknown as AuthenticatedRequest;
  const responseHeaders: Record<string, string> = {};
  const response = {
    setHeader: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
  };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  const reflector = {
    getAllAndOverride: () => options.isPublic,
  } as unknown as Reflector;
  const authenticate = jest.fn<ApiKeyAuthenticator['authenticate']>(() =>
    Promise.resolve(
      options.result ?? { authenticated: false, reason: 'unknown_prefix' },
    ),
  );
  const guard = new ApiKeyGuard(reflector, {
    authenticate,
  } as unknown as ApiKeyAuthenticator);

  return { guard, context, request, responseHeaders, authenticate };
}

async function rejection(promise: Promise<boolean>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the guard to reject');
}

describe('ApiKeyGuard', () => {
  let warn: jest.SpiedFunction<Logger['warn']>;

  beforeEach(() => {
    jest.restoreAllMocks();
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  it('lets public routes through without authenticating', async () => {
    const { guard, context, authenticate } = setup({ isPublic: true });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('rejects a request without an Authorization header', async () => {
    const { guard, context, responseHeaders } = setup({});

    const error = await rejection(guard.canActivate(context));

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(error.message).toBe('Missing API key');
    expect(responseHeaders['WWW-Authenticate']).toBe('Bearer realm="PayGuard"');
  });

  it.each(['Basic dXNlcjpwYXNz', `Token ${VALID_LOOKING_KEY}`, 'Bearer'])(
    'rejects a non-Bearer Authorization header (%s) without a lookup',
    async (authorization) => {
      const { guard, context, authenticate } = setup({ authorization });

      const error = await rejection(guard.canActivate(context));

      expect(error.message).toBe('Invalid API key');
      expect(authenticate).not.toHaveBeenCalled();
    },
  );

  it('rejects with one generic message whatever the internal reason', async () => {
    const { guard, context, responseHeaders } = setup({
      authorization: `Bearer ${VALID_LOOKING_KEY}`,
      result: {
        authenticated: false,
        reason: 'revoked',
        keyPrefix: '0123456789abcdef',
      },
    });

    const error = await rejection(guard.canActivate(context));

    expect(error.message).toBe('Invalid API key');
    expect(responseHeaders['WWW-Authenticate']).toContain(
      'error="invalid_token"',
    );
    expect(warn).toHaveBeenCalledWith('API key rejected', {
      reason: 'revoked',
      keyPrefix: '0123456789abcdef',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(VALID_LOOKING_KEY);
  });

  it('attaches the authenticated merchant to the request and log context', async () => {
    const merchant = { merchantId: 'merchant-1', apiKeyId: 'key-1' };
    const { guard, context, request, authenticate } = setup({
      authorization: `bearer ${VALID_LOOKING_KEY}`,
      result: { authenticated: true, merchant },
    });
    const store = { requestId: 'req-1' } as {
      requestId: string;
      merchantId?: string;
    };

    await requestContext.run(store, () => guard.canActivate(context));

    expect(authenticate).toHaveBeenCalledWith(VALID_LOOKING_KEY);
    expect(request.merchant).toEqual(merchant);
    expect(store.merchantId).toBe('merchant-1');
  });
});
