import crypto from 'crypto';
import { RefreshToken, IRefreshToken } from '../models/RefreshToken';

const digest = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
// `token` holds the digest; rows from before hashing was introduced hold the token itself until they expire
const matching = (token: string) => ({ token: { $in: [digest(token), token] } });

export const tokenRepository = {
  async createRefreshToken(userId: string, token: string, expiresAt: Date): Promise<IRefreshToken> {
    const rt = new RefreshToken({ userId, token: digest(token), expiresAt });
    return rt.save();
  },

  async findByToken(token: string): Promise<IRefreshToken | null> {
    return RefreshToken.findOne(matching(token));
  },

  /**
   * Exchanges a token exactly once. The check and the revocation are one database step, so simultaneous requests with the
   * same token cannot both succeed. Returns null when it is unknown, expired, revoked or already exchanged.
   */
  async consumeForRotation(token: string): Promise<IRefreshToken | null> {
    const now = new Date();
    return RefreshToken.findOneAndUpdate(
      { ...matching(token), isRevoked: false, expiresAt: { $gt: now } },
      { $set: { isRevoked: true, rotatedAt: now } }
    );
  },

  async revokeToken(token: string): Promise<void> {
    await RefreshToken.updateOne(matching(token), { isRevoked: true });
  },

  async revokeAllForUser(userId: string): Promise<void> {
    await RefreshToken.updateMany({ userId, isRevoked: false }, { isRevoked: true });
  }
};
