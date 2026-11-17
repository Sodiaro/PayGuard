import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebhookDeliveryClient } from './webhook-delivery-client.js';

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describe('WebhookDeliveryClient', () => {
  const received: Received[] = [];
  let respond: (request: Received) => {
    status: number;
    delayMs?: number;
  } = () => ({ status: 200 });
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        const entry = {
          method: request.method!,
          url: request.url!,
          headers: request.headers,
          body,
        };
        received.push(entry);
        const { status, delayMs = 0 } = respond(entry);
        setTimeout(() => {
          response.statusCode = status;
          if (status === 302) response.setHeader('location', '/elsewhere');
          response.end('ok');
        }, delayMs);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const local = new WebhookDeliveryClient(true);

  it('POSTs the exact body with its headers and reports a 2xx as delivered', async () => {
    respond = () => ({ status: 204 });
    received.length = 0;

    await expect(
      local.post(`${base}/hook?x=1`, '{"a":1}', { 'PayGuard-Event-Id': 'e1' }),
    ).resolves.toEqual({ delivered: true, status: 204 });
    expect(received).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/hook?x=1',
        body: '{"a":1}',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'payguard-event-id': 'e1',
          'user-agent': 'PayGuard-Webhooks/1',
        }),
      }),
    ]);
  });

  it.each([500, 404, 302])(
    'reports HTTP %i as a failure with its status, without following redirects',
    async (status) => {
      respond = () => ({ status });
      received.length = 0;

      await expect(local.post(`${base}/hook`, '{}', {})).resolves.toEqual({
        delivered: false,
        status,
        error: 'HTTP_STATUS',
      });
      expect(received.map((r) => r.url)).toEqual(['/hook']);
    },
  );

  it('gives up on an endpoint that does not answer in time', async () => {
    respond = () => ({ status: 200, delayMs: 500 });
    const impatient = new WebhookDeliveryClient(true, undefined, 50);

    await expect(impatient.post(`${base}/slow`, '{}', {})).resolves.toEqual({
      delivered: false,
      status: null,
      error: 'TIMEOUT',
    });
  });

  it('reports an endpoint that refuses connections', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    await expect(
      local.post(`http://127.0.0.1:${port}/`, '{}', {}),
    ).resolves.toMatchObject({ delivered: false, error: 'CONNECTION_FAILED' });
  });

  describe('when private targets are not allowed', () => {
    it('refuses a local address without connecting', async () => {
      received.length = 0;
      const strict = new WebhookDeliveryClient(false);

      await expect(strict.post(`${base}/hook`, '{}', {})).resolves.toEqual({
        delivered: false,
        status: null,
        error: 'TARGET_BLOCKED',
      });
      await expect(
        strict.post('https://[::1]/hook', '{}', {}),
      ).resolves.toMatchObject({ error: 'TARGET_BLOCKED' });
      expect(received).toHaveLength(0);
    });

    it.each([
      ['only a private address', [{ address: '10.0.0.5', family: 4 }]],
      [
        'a public and a private address',
        [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      ],
      ['nothing', []],
    ])('refuses a host name that resolves to %s', async (_case, addresses) => {
      const strict = new WebhookDeliveryClient(false, (_host, callback) =>
        callback(null, addresses),
      );

      await expect(
        strict.post('https://hooks.example.test/hook', '{}', {}),
      ).resolves.toMatchObject({ delivered: false, error: 'TARGET_BLOCKED' });
    });
  });
});
