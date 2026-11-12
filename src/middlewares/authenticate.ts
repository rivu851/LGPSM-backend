import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../utils/token';
import { User } from '../models/User';
import { securityEvent } from '../utils/securityLog';
import { userAuthCache } from '../utils/userAuthCache';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Authentication required. Missing Bearer token.' });
      return;
    }

    const token = authHeader.split(' ')[1];
    let payload: TokenPayload;
    try {
      payload = verifyAccessToken(token);
    } catch (err: any) {
      securityEvent('AUTH_TOKEN_REJECTED', req, { reason: err?.name || 'invalid' });
      res.status(401).json({ success: false, message: 'Invalid or expired token.' });
      return;
    }

    // Verify user still exists and is active. Only the two fields needed are read, and the answer is kept for a few seconds
    // (cleared at once whenever an account is written), so a burst of requests costs one database read, not one each.
    let account = userAuthCache.get(payload.userId);
    if (!account) {
      const user = await User.findById(payload.userId).select('role isActive').lean<{ role: string; isActive: boolean }>();
      if (!user) {
        res.status(401).json({ success: false, message: 'User no longer exists.' });
        return;
      }
      account = { role: user.role, isActive: user.isActive };
      userAuthCache.set(payload.userId, account);
    }
    if (!account.isActive) {
      securityEvent('AUTH_INACTIVE_USER', req, { subject: String(payload.userId) });
      res.status(403).json({ success: false, code: 'ACCOUNT_INACTIVE', message: 'User account is inactive.' });
      return;
    }

    // The role is read from the database, not the token, so demotions apply immediately instead of
    // surviving until the access token expires.
    req.user = { ...payload, role: account.role as TokenPayload['role'] };
    next();
  } catch (error) {
    next(error);
  }
};
