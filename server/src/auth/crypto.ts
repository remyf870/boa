// Small crypto helpers. Algorithms documented in docs/CRYPTO.md (A.8.24).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM, key supplied as 64 hex chars. Output: base64(iv ‖ tag ‖ ciphertext). */
export function encryptSecret(keyHex: string, plaintext: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(keyHex: string, encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
