import type { NextFunction, Request, Response } from 'express';
import { kv } from '../infra/kv';

/** After a successful upload, the same person cannot upload to the same event again for this long (a preview does not count) */
export const IMPORT_COOLDOWN_MS = 15_000;
/** An upload that has been "running" this long is taken to have died with its process, and the lock is let go */
const LOCK_MS = 5 * 60_000;

// Off under test unless a test opts in (like the other limits)
const skip = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_TESTS !== 'true';

/**
 * One Excel upload at a time per person and event, and a short cooldown after a successful one. A second upload that arrives while the
 * first is still running is refused (409), and so is one that arrives inside the cooldown (429, with how many seconds to wait). A preview
 * (dryRun) changes nothing, so it can run beside nothing else but never starts a cooldown. Place it after the file has been read, because
 * whether it is a preview is in the form.
 */
export async function importGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (skip()) return next();
  const userId = (req as any).user?.userId;
  if (!userId) return next();
  const eventId = String(req.params.eventId || '');
  const dry = String((req.body as any)?.dryRun ?? req.query.dryRun ?? '') === 'true';
  const lockKey = `imp:lock:${userId}:${eventId}`;
  const coolKey = `imp:cool:${userId}:${eventId}`;
  try {
    if (!dry) {
      const until = Number(await kv.get(coolKey));
      const left = until - Date.now();
      if (Number.isFinite(left) && left > 0) {
        const seconds = Math.ceil(left / 1000);
        res.setHeader('Retry-After', String(seconds));
        res.status(429).json({ success: false, code: 'UPLOAD_COOLDOWN', retryAfterSeconds: seconds, message: `Please wait ${seconds} second${seconds === 1 ? '' : 's'} before uploading again.` });
        return;
      }
    }
    if (!(await kv.setNX(lockKey, '1', LOCK_MS))) {
      res.status(409).json({ success: false, code: 'UPLOAD_IN_PROGRESS', message: 'Your invitee list is still being uploaded. Please wait for it to finish.' });
      return;
    }
  } catch {
    return next(); // the store is out of reach: a guard must never block the upload
  }
  res.on('close', () => {
    void kv.del(lockKey).catch(() => undefined);
    if (!dry && res.statusCode >= 200 && res.statusCode < 300) void kv.set(coolKey, String(Date.now() + IMPORT_COOLDOWN_MS), IMPORT_COOLDOWN_MS).catch(() => undefined);
  });
  next();
}
