import express, { type RequestHandler } from 'express';

export const WEBHOOK_PATH_PREFIX = '/v1/webhooks';
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

// Webhook bodies are read as raw bytes, ahead of the JSON parser (which then skips them), because
// the signature covers the exact bytes received. Compressed bodies are refused rather than inflated
// so the verified bytes are the bytes on the wire. The content type is checked by the controller.
export function webhookRawBody(): RequestHandler {
  return express.raw({
    type: () => true,
    limit: WEBHOOK_MAX_BODY_BYTES,
    inflate: false,
  });
}
