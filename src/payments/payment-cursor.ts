export interface PaymentCursor {
  createdAt: Date;
  id: string;
}

const UUID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CURSOR_LENGTH = 200;

// Opaque to clients: the position of the last payment on a page, in (createdAt, id) order.
export function encodePaymentCursor(cursor: PaymentCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.createdAt.toISOString(), cursor.id]),
    'utf8',
  ).toString('base64url');
}

export function decodePaymentCursor(value: string): PaymentCursor | null {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [timestamp, id] = parsed as unknown[];
  if (typeof timestamp !== 'string' || typeof id !== 'string') return null;
  if (!UUID_FORMAT.test(id)) return null;
  const createdAt = new Date(timestamp);
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== timestamp
  ) {
    return null;
  }
  return { createdAt, id };
}
