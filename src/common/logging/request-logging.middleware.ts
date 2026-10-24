import { Logger } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/authenticated-merchant.js';
import { REQUEST_ID_HEADER } from '../http/request-id.middleware.js';

const logger = new Logger('HTTP');

// One access-log line per request. Only method, path (query string dropped, it may carry
// credentials), status and timing are recorded: never headers or bodies.
export function requestLoggingMiddleware(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): void {
  const startedAt = process.hrtime.bigint();

  response.on('finish', () => {
    const path = request.originalUrl.split('?')[0];
    if (path.startsWith('/health') && response.statusCode < 400) return;

    // 'finish' can fire outside the request's async context, so correlation is passed explicitly.
    logger.log('Request completed', {
      requestId: response.getHeader(REQUEST_ID_HEADER),
      merchantId: request.merchant?.merchantId,
      method: request.method,
      path,
      statusCode: response.statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    });
  });

  next();
}
