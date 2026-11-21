import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { kv } from '../infra/kv';
import { securityEvent } from '../utils/securityLog';

// Off under test unless a test opts in (like the other limiters), so a suite is never slowed or refused by a limit it is not testing
const skip = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_TESTS !== 'true';

const who = (req: Request) => (req as any).user?.userId ? `u:${(req as any).user.userId}` : `ip:${ipKeyGenerator(req.ip || '')}`;

function refuse(req: Request, res: Response, name: string, windowMs: number, ttlMs: number, max: number, message?: string) {
  const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
  securityEvent('RATE_LIMITED', req, { limiter: name });
  res.setHeader('Retry-After', String(seconds));
  res.setHeader('RateLimit-Limit', String(max));
  res.setHeader('RateLimit-Remaining', '0');
  res.setHeader('RateLimit-Reset', String(seconds));
  res.status(429).json({
    success: false, code: 'RATE_LIMITED', retryAfterSeconds: seconds,
    message: message || `You are doing that too often. Please try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
  });
}

/** Counts this request; false when the person is over the limit (the 429 has then been sent) */
export async function consumeUserLimit(req: Request, res: Response, name: string, opts: { windowMs: number; max: number; message?: string }): Promise<boolean> {
  if (skip()) return true;
  try {
    const { count, ttlMs } = await kv.incr(`ul:${name}:${who(req)}`, opts.windowMs);
    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.max - count)));
    if (count > opts.max) { refuse(req, res, name, opts.windowMs, ttlMs, opts.max, opts.message); return false; }
  } catch {
    // the counter store is out of reach: a limit must never take the app down
  }
  return true;
}

/**
 * At most `max` requests per `windowMs` for each signed-in person (each address when there is no sign-in), counted per `name`. Stops one
 * account from hammering an endpoint, however many devices or addresses it uses. The count expires by itself when the window ends.
 */
export function perUserLimit(name: string, opts: { windowMs: number; max: number; message?: string }): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (await consumeUserLimit(req, res, name, opts)) next();
  };
}

/** Used by `authenticate`: every signed-in request counts toward one generous ceiling per person (10 a second on average) */
export const GENERAL_USER_LIMIT = { windowMs: 60_000, max: 600, message: 'Too many requests. Please slow down and try again in a moment.' };

/**
 * Refuses the exact same request (same person, same address, same body) arriving again within `ttlMs`: a double tap, or a retry loop.
 * A request that fails is forgotten at once, so the person can correct it and try again without waiting.
 */
export function dedupeWindow(name: string, ttlMs: number): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (skip()) return next();
    let key = '';
    try {
      const fingerprint = crypto.createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path} ${JSON.stringify(req.body ?? {})} ${JSON.stringify(req.query ?? {})}`).digest('hex').slice(0, 32);
      key = `dd:${name}:${who(req)}:${fingerprint}`;
      if (!(await kv.setNX(key, '1', ttlMs))) {
        const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
        res.setHeader('Retry-After', String(seconds));
        res.status(429).json({ success: false, code: 'DUPLICATE_REQUEST', retryAfterSeconds: seconds, message: 'That request was just received. Please wait a moment before trying again.' });
        return;
      }
    } catch {
      return next();
    }
    res.on('finish', () => { if (res.statusCode >= 400) void kv.del(key).catch(() => undefined); });
    next();
  };
}
