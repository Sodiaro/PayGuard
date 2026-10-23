import { describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  requestIdMiddleware,
} from './request-id.middleware.js';

function run(incoming?: string): { request: Request; responseId: string } {
  const headers: Record<string, string | undefined> = {
    [REQUEST_ID_HEADER]: incoming,
  };
  const request = {
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;

  let responseId = '';
  const response = {
    setHeader: (name: string, value: string) => {
      if (name === REQUEST_ID_HEADER) responseId = value;
    },
  } as unknown as Response;

  const next = jest.fn();
  requestIdMiddleware(request, response, next);
  expect(next).toHaveBeenCalledTimes(1);

  return { request, responseId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('requestIdMiddleware', () => {
  it('generates an ID when the caller sends none', () => {
    const { request, responseId } = run();

    expect(responseId).toMatch(UUID);
    expect(request.headers[REQUEST_ID_HEADER]).toBe(responseId);
  });

  it('reuses a well-formed caller ID', () => {
    const { responseId } = run('checkout-7f3a.42');

    expect(responseId).toBe('checkout-7f3a.42');
  });

  it.each([
    ['contains spaces', 'bad id'],
    ['contains a newline', 'id\nInjected: header'],
    ['is too long', 'a'.repeat(129)],
  ])('replaces a caller ID that %s', (_reason, incoming) => {
    const { responseId } = run(incoming);

    expect(responseId).toMatch(UUID);
  });
});
