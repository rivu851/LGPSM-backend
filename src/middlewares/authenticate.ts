import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../utils/token';
import { User } from '../models/User';
import { securityEvent } from '../utils/securityLog';

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

    // Verify user still exists and is active
    const user = await User.findById(payload.userId);
    if (!user) {
      res.status(401).json({ success: false, message: 'User no longer exists.' });
      return;
    }
    if (!user.isActive) {
      securityEvent('AUTH_INACTIVE_USER', req, { subject: String(user._id) });
      res.status(403).json({ success: false, message: 'User account is inactive.' });
      return;
    }

    // The role is read from the database, not the token, so demotions apply immediately instead of
    // surviving until the access token expires.
    req.user = { ...payload, role: user.role };
    next();
  } catch (error) {
    next(error);
  }
};
