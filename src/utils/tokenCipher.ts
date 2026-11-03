import crypto from 'crypto';
import { env } from '../config/env';

// Invitation tokens are looked up by SHA-256 hash. A copy is also kept encrypted (AES-256-GCM) so an
// organizer can re-download the guest's current card with a QR that still checks in. The key never
// lives in the database: QR_TOKEN_SECRET when configured, otherwise derived from JWT_SECRET.
// Copies written before QR_TOKEN_SECRET was set stay readable, so setting it never breaks links or passes already issued.
const deriveKey = (secret: string): Buffer => crypto.createHash('sha256').update(`lgpsm-qr-token:${secret}`).digest();
const key = (): Buffer => deriveKey(process.env.QR_TOKEN_SECRET || env.JWT_SECRET);
const readKeys = (): Buffer[] => (process.env.QR_TOKEN_SECRET ? [deriveKey(process.env.QR_TOKEN_SECRET), deriveKey(env.JWT_SECRET)] : [deriveKey(env.JWT_SECRET)]);

export const encryptToken = (token: string): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
};

export const decryptToken = (payload: string | undefined | null): string | null => {
  if (!payload) return null;
  for (const candidate of readKeys()) {
    try {
      const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', candidate, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      // authentication failed under this key: try the next one
    }
  }
  return null;
};
