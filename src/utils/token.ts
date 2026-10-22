import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { Role } from '../models/User';

export interface TokenPayload {
  userId: string;
  role: Role;
  type: 'access' | 'refresh' | 'reset';
  // reset tokens only: fingerprint of the password hash they were issued against
  pwf?: string;
}

export function generateAccessToken(userId: string, role: Role): string {
  const payload: TokenPayload = { userId, role, type: 'access' };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });
}

export function generateRefreshToken(userId: string, role: Role): string {
  const payload: TokenPayload & { nonce: string } = { userId, role, type: 'refresh', nonce: crypto.randomBytes(12).toString('hex') };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES_IN as any });
}

export function verifyAccessToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as TokenPayload;
  if (decoded.type !== 'access') {
    throw new Error('Invalid token type');
  }
  return decoded;
}

export function verifyRefreshToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as TokenPayload;
  if (decoded.type !== 'refresh') {
    throw new Error('Invalid token type');
  }
  return decoded;
}

// Single-purpose password reset token; it cannot be used as an API access token
export function passwordFingerprint(passwordHash: string | undefined | null): string {
  return crypto.createHash('sha256').update(passwordHash ?? '').digest('hex').slice(0, 16);
}

// The token carries a fingerprint of the current password hash, so it stops working as soon as the
// password changes: a reset link can be used once, and an old link dies after any other password change.
export function generatePasswordResetToken(userId: string, role: Role, passwordHash?: string | null): string {
  const payload: TokenPayload = { userId, role, type: 'reset', pwf: passwordFingerprint(passwordHash) };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '15m' });
}

export function verifyPasswordResetToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as TokenPayload;
  if (decoded.type !== 'reset') {
    throw new Error('Invalid token type');
  }
  return decoded;
}
