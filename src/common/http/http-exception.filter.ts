import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { ErrorResponse } from './error-response.js';
import { REQUEST_ID_HEADER } from './request-id.middleware.js';
import { RequestValidationException } from './validation.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const requestId = String(response.getHeader(REQUEST_ID_HEADER) ?? '');
    // Query strings are dropped from both the response and the log: they are where leaked credentials turn up.
    const path = request.originalUrl.split('?')[0];

    const body: ErrorResponse = {
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Error',
      message: this.clientMessage(exception, statusCode),
      ...(exception instanceof RequestValidationException && {
        details: exception.details,
      }),
      path,
      timestamp: new Date().toISOString(),
      requestId,
    };

    // Request bodies are deliberately not logged: they can carry credentials or card data.
    if (statusCode >= 500) {
      this.logger.error(
        `Unhandled error: ${request.method} ${path} -> ${statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(statusCode).json(body);
  }

  private clientMessage(exception: unknown, statusCode: number): string {
    if (!(exception instanceof HttpException)) {
      return 'An unexpected error occurred';
    }

    const payload = exception.getResponse();
    if (typeof payload === 'string') {
      return payload;
    }

    const { message } = payload as { message?: unknown };
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message)) {
      return message.join('; ');
    }
    return STATUS_CODES[statusCode] ?? 'Error';
  }
}
