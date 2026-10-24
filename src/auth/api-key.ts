import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Format: pgsk_<16 hex lookup prefix>_<43 base64url chars = 256-bit secret>.
// The prefix is not secret: it is stored in plaintext and used to find the key record.
const PREFIX_BYTES = 8;
const SECRET_BYTES = 32;
const API_KEY_FORMAT = /^pgsk_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

// Anything that looks like a PayGuard key, including malformed ones, for scrubbing logs.
export const API_KEY_LIKE = /pgsk_[A-Za-z0-9_-]{8,}/g;

export interface GeneratedApiKey {
  plaintext: string;
  prefix: string;
  secretHash: Uint8Array<ArrayBuffer>;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    plaintext: `pgsk_${prefix}_${secret}`,
    prefix,
    secretHash: hashSecret(secret),
  };
}

export function parseApiKey(
  candidate: string,
): { prefix: string; secret: string } | null {
  const match = API_KEY_FORMAT.exec(candidate);
  return match ? { prefix: match[1], secret: match[2] } : null;
}

// A single SHA-256 is deliberate. Slow KDFs (bcrypt, argon2) protect low-entropy
// human passwords from offline guessing; a 256-bit random secret cannot be guessed
// either way, and a slow hash would only add CPU cost to every authenticated request.
export function hashSecret(secret: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(secret, 'utf8').digest());
}

export function secretMatches(secret: string, storedHash: Uint8Array): boolean {
  const candidate = hashSecret(secret);
  return (
    candidate.length === storedHash.length &&
    timingSafeEqual(candidate, storedHash)
  );
}

export function displayPrefix(prefix: string): string {
  return `pgsk_${prefix}`;
}
