import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { MerchantWebhookDeliveryError } from '../generated/prisma/enums.js';
import {
  hostOf,
  isPublicAddress,
  webhookUrlProblem,
} from './webhook-targets.js';

export const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type DeliveryResult =
  | { delivered: true; status: number }
  | {
      delivered: false;
      status: number | null;
      error: MerchantWebhookDeliveryError;
    };

type Resolver = (
  hostname: string,
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolver: Resolver = (hostname, callback) =>
  dnsLookup(hostname, { all: true }, callback);

class BlockedTargetError extends Error {}

// POSTs one delivery. Never throws: every failure becomes a sanitized error category, and nothing
// from the response is kept but its status. Redirects are not followed, since a redirect could
// lead past the address checks. Unless private targets are allowed, every address the host
// resolves to must be public, and the connection is made to an address that was checked, so a
// name that changes its answer between check and connect (DNS rebinding) cannot slip through.
export class WebhookDeliveryClient {
  constructor(
    private readonly allowPrivateTargets: boolean,
    private readonly resolve: Resolver = systemResolver,
    private readonly timeoutMs = DELIVERY_TIMEOUT_MS,
  ) {}

  async post(
    target: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<DeliveryResult> {
    if (webhookUrlProblem(target, this.allowPrivateTargets)) {
      return blocked();
    }
    const url = new URL(target);
    const host = hostOf(url);
    if (isIP(host) !== 0 && !this.allowed(host)) return blocked();

    try {
      const status = await this.send(url, body, headers);
      if (status < 100 || status > 599) {
        return {
          delivered: false,
          status: null,
          error: MerchantWebhookDeliveryError.CONNECTION_FAILED,
        };
      }
      return status >= 200 && status < 300
        ? { delivered: true, status }
        : {
            delivered: false,
            status,
            error: MerchantWebhookDeliveryError.HTTP_STATUS,
          };
    } catch (error) {
      return {
        delivered: false,
        status: null,
        error:
          error instanceof BlockedTargetError
            ? MerchantWebhookDeliveryError.TARGET_BLOCKED
            : error instanceof DeliveryTimeoutError
              ? MerchantWebhookDeliveryError.TIMEOUT
              : MerchantWebhookDeliveryError.CONNECTION_FAILED,
      };
    }
  }

  private allowed(address: string): boolean {
    return this.allowPrivateTargets || isPublicAddress(address);
  }

  private send(
    url: URL,
    body: string,
    headers: Record<string, string>,
  ): Promise<number> {
    const lookup: LookupFunction = (hostname, options, callback) => {
      this.resolve(hostname, (error, addresses) => {
        if (error) return callback(error, '', 0);
        const usable = addresses.filter((entry) =>
          options.family ? entry.family === options.family : true,
        );
        if (
          usable.length === 0 ||
          usable.some((entry) => !this.allowed(entry.address))
        ) {
          return callback(new BlockedTargetError(), '', 0);
        }
        if (options.all) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(
            null,
            usable,
          );
        } else {
          callback(null, usable[0].address, usable[0].family);
        }
      });
    };

    const payload = Buffer.from(body, 'utf8');
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const request = send(
        url,
        {
          method: 'POST',
          lookup,
          headers: {
            ...headers,
            'content-type': 'application/json',
            'content-length': String(payload.length),
            'user-agent': 'PayGuard-Webhooks/1',
          },
        },
        (response: IncomingMessage) => {
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) response.destroy();
          });
          response.on('error', () => resolve(response.statusCode ?? 0));
          response.on('close', () => resolve(response.statusCode ?? 0));
          response.resume();
        },
      );
      const timer = setTimeout(
        () => request.destroy(new DeliveryTimeoutError()),
        this.timeoutMs,
      );
      timer.unref();
      request.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      request.on('close', () => clearTimeout(timer));
      request.end(payload);
    });
  }
}

class DeliveryTimeoutError extends Error {}

function blocked(): DeliveryResult {
  return {
    delivered: false,
    status: null,
    error: MerchantWebhookDeliveryError.TARGET_BLOCKED,
  };
}
