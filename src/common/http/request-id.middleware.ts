import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../logging/request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';

// Caller-supplied IDs end up in logs and response headers, so restrict them to a safe token.
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const incoming = request.header(REQUEST_ID_HEADER);
  const requestId =
    incoming && ACCEPTABLE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

  request.headers[REQUEST_ID_HEADER] = requestId;
  response.setHeader(REQUEST_ID_HEADER, requestId);
  requestContext.run({ requestId }, next);
}
