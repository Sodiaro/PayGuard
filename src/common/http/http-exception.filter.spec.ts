import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ArgumentsHost,
  ConflictException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorResponse } from './error-response.js';
import { HttpExceptionFilter } from './http-exception.filter.js';
import { REQUEST_ID_HEADER } from './request-id.middleware.js';
import { RequestValidationException } from './validation.js';

interface Captured {
  status?: number;
  body?: ErrorResponse;
}

function hostFor(captured: Captured): ArgumentsHost {
  const request = {
    method: 'POST',
    originalUrl: '/v1/things',
  } as Request;
  const response = {
    getHeader: (name: string) =>
      name === REQUEST_ID_HEADER ? 'req-123' : undefined,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: ErrorResponse) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;

  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();
  let captured: Captured;
  let logError: jest.SpiedFunction<Logger['error']>;

  beforeEach(() => {
    captured = {};
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    logError.mockClear();
  });

  it('renders an HttpException with the standard envelope', () => {
    filter.catch(new NotFoundException('Payment not found'), hostFor(captured));

    expect(captured.status).toBe(HttpStatus.NOT_FOUND);
    expect(captured.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Payment not found',
      path: '/v1/things',
      timestamp: expect.any(String) as unknown as string,
      requestId: 'req-123',
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it('uses the status text when the exception has no message', () => {
    filter.catch(new ConflictException(), hostFor(captured));

    expect(captured.body?.message).toBe('Conflict');
  });

  it('includes field details for validation failures', () => {
    const details = [
      { field: 'amount', messages: ['amount must be positive'] },
    ];
    filter.catch(new RequestValidationException(details), hostFor(captured));

    expect(captured.status).toBe(HttpStatus.BAD_REQUEST);
    expect(captured.body).toMatchObject({
      message: 'Validation failed',
      details,
    });
  });

  it('keeps the client status of body-parser errors without echoing their message', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
      type: 'entity.too.large',
    });
    filter.catch(tooLarge, hostFor(captured));

    expect(captured.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(captured.body?.message).toBe('Payload Too Large');
    expect(logError).not.toHaveBeenCalled();
  });

  it('does not trust a status on errors that are not marked safe to expose', () => {
    filter.catch(
      Object.assign(new Error('upstream said 404'), { status: 404 }),
      hostFor(captured),
    );

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('hides unexpected errors behind a generic 500 and logs them', () => {
    filter.catch(
      new Error('connection refused at db.internal:5432'),
      hostFor(captured),
    );

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body?.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(captured.body)).not.toContain('db.internal');
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
