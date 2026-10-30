import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// Correlates a request with its audit entries. A caller-supplied id is only kept when it is a short safe token.
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  (req as any).requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
