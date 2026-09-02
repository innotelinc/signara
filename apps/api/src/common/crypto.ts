import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = 'enc:v1:';

/**
 * Secret-at-rest encryption for private key material (AES-256-GCM).
 *
 * The key is derived from the deployment master secret (CRYPTO_MASTER_KEY)
 * with SHA-256. Payload format: `enc:v1:<ivBase64url>:<tagBase64url>:<dataBase64url>`
 * Each encryption uses a fresh random IV — never reuse nonces with AES-GCM.
 */
export function deriveKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  if (!masterKey) {
    throw new Error('CRYPTO_MASTER_KEY is not configured — cannot persist private key material');
  }
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['enc', 'v1', iv, tag, encrypted].map((part) => part.toString('base64url')).join(':');
}

export function decryptSecret(payload: string, masterKey: string): string {
  if (!masterKey) {
    throw new Error('CRYPTO_MASTER_KEY is not configured — cannot decrypt private key material');
  }
  const parts = payload.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Unsupported secret payload format');
  }
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  const data = Buffer.from(parts[4], 'base64url');
  const decipher = createDecipheriv(ALGO, deriveKey(masterKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}