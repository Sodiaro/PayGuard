import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { RequestValidationException } from '../common/http/validation.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeyProblem,
} from './idempotency.js';

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const value = context
      .switchToHttp()
      .getRequest<Request>()
      .header(IDEMPOTENCY_KEY_HEADER);
    const problem = idempotencyKeyProblem(value);
    if (problem) {
      throw new RequestValidationException([
        { field: 'Idempotency-Key', messages: [problem] },
      ]);
    }
    return value!;
  },
);
