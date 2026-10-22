import { Request, Response, NextFunction } from 'express';
import { Role } from '../models/User';
import { securityEvent } from '../utils/securityLog';

export const authorizeRoles = (...roles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      securityEvent('AUTHZ_DENIED', req, { required: roles.join(',') });
      res.status(403).json({ success: false, message: 'Forbidden. Insufficient permissions.' });
      return;
    }

    next();
  };
};
