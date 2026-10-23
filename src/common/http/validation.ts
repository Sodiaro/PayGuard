import {
  BadRequestException,
  type ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ErrorDetail } from './error-response.js';

export class RequestValidationException extends BadRequestException {
  constructor(readonly details: ErrorDetail[]) {
    super('Validation failed');
  }
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new RequestValidationException(toErrorDetails(errors)),
  });
}

export function toErrorDetails(
  errors: ValidationError[],
  parentPath = '',
): ErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    const own: ErrorDetail[] = error.constraints
      ? [{ field, messages: Object.values(error.constraints) }]
      : [];
    return [...own, ...toErrorDetails(error.children ?? [], field)];
  });
}
