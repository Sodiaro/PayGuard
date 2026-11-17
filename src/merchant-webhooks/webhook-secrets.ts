import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// After a rotation, deliveries are also signed with the previous secret for this long, so the
// merchant can deploy the new one without rejecting deliveries in between.
export const PREVIOUS_SECRET_OVERLAP_HOURS = 24;

export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

// AES-256-GCM, bound to the merchant as associated data: a ciphertext copied onto another
// merchant's endpoint fails to decrypt instead of signing that merchant's deliveries.
// Layout: version (1 byte) | IV (12) | auth tag (16) | ciphertext.
export class WebhookSecretCipher {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) {
      throw new Error('The webhook encryption key must be 32 bytes');
    }
  }

  encrypt(secret: string, merchantId: string): Uint8Array<ArrayBuffer> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(merchantId, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    return new Uint8Array(
      Buffer.concat([
        Buffer.from([VERSION]),
        iv,
        cipher.getAuthTag(),
        ciphertext,
      ]),
    );
  }

  decrypt(sealed: Uint8Array, merchantId: string): string {
    const buffer = Buffer.from(sealed);
    if (buffer[0] !== VERSION || buffer.length <= 1 + IV_BYTES + TAG_BYTES) {
      throw new Error('Unrecognised webhook secret ciphertext');
    }
    const iv = buffer.subarray(1, 1 + IV_BYTES);
    const tag = buffer.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(merchantId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(buffer.subarray(1 + IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }
}
