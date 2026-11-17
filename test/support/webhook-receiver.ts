import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWebhookSignature } from '../../src/webhooks/webhook-signature.js';

export interface Delivery {
  headers: IncomingHttpHeaders;
  body: string;
}

// A merchant's endpoint, on 127.0.0.1: records every delivery and answers with a status the test
// chooses.
export async function startWebhookReceiver() {
  const deliveries: Delivery[] = [];
  let status = 200;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      deliveries.push({ headers: request.headers, body });
      response.statusCode = status;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/payguard/webhooks`,
    deliveries,
    answerWith(next: number) {
      status = next;
    },
    reset() {
      deliveries.length = 0;
      status = 200;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// How a merchant verifies a delivery: any one v1 signature made with its secret is enough.
export function verifiesWith(delivery: Delivery, secret: string): boolean {
  const header = delivery.headers['payguard-signature'];
  if (typeof header !== 'string') return false;
  const [timestamp, ...signatures] = header.split(',');
  return signatures.some(
    (signature) =>
      verifyWebhookSignature({
        secret,
        header: `${timestamp},${signature}`,
        rawBody: Buffer.from(delivery.body, 'utf8'),
        nowSeconds: Math.floor(Date.now() / 1000),
        toleranceSeconds: 300,
      }).valid,
  );
}
