import { createHmac, timingSafeEqual } from 'node:crypto';

// t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>." followed by the raw body bytes>
const SIGNATURE_HEADER_FORMAT = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;
const MAX_SIGNATURE_HEADER_LENGTH = 128;

export type SignatureRejection =
  | 'missing'
  | 'malformed'
  | 'timestamp_too_old'
  | 'timestamp_in_future'
  | 'mismatch';

export type SignatureVerification =
  | { valid: true; timestamp: number }
  | { valid: false; reason: SignatureRejection };

export interface VerifySignatureInput {
  secret: string;
  header: string | string[] | undefined;
  rawBody: Buffer;
  nowSeconds: number;
  toleranceSeconds: number;
}

// The timestamp is part of the signed input, so it cannot be changed to make an old delivery look
// fresh. Bytes are hashed exactly as received: parsing and re-serializing JSON could change them.
export function computeWebhookSignature(
  secret: string,
  timestamp: number,
  rawBody: Buffer | string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest('hex');
}

export function webhookSignatureHeader(
  secret: string,
  timestamp: number,
  rawBody: Buffer | string,
): string {
  return `t=${timestamp},v1=${computeWebhookSignature(secret, timestamp, rawBody)}`;
}

export function verifyWebhookSignature(
  input: VerifySignatureInput,
): SignatureVerification {
  const { header } = input;
  if (header === undefined || header === '') {
    return { valid: false, reason: 'missing' };
  }
  // A repeated header is ambiguous: which copy was signed is unknowable.
  if (Array.isArray(header) || header.length > MAX_SIGNATURE_HEADER_LENGTH) {
    return { valid: false, reason: 'malformed' };
  }
  const match = SIGNATURE_HEADER_FORMAT.exec(header);
  if (!match) return { valid: false, reason: 'malformed' };

  const timestamp = Number(match[1]);
  if (input.nowSeconds - timestamp > input.toleranceSeconds) {
    return { valid: false, reason: 'timestamp_too_old' };
  }
  if (timestamp - input.nowSeconds > input.toleranceSeconds) {
    return { valid: false, reason: 'timestamp_in_future' };
  }

  // Both sides are exactly 32 bytes here: the format check fixed the presented length.
  const expected = Buffer.from(
    computeWebhookSignature(input.secret, timestamp, input.rawBody),
    'hex',
  );
  const presented = Buffer.from(match[2], 'hex');
  if (!timingSafeEqual(expected, presented)) {
    return { valid: false, reason: 'mismatch' };
  }
  return { valid: true, timestamp };
}
