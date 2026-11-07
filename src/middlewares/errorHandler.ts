import { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ success: false, message: 'Route not found' });
}

type ErrorLike = {
  name?: string;
  message?: string;
  stack?: string;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  // Set by code that throws a 5xx whose message is safe and useful to show the client
  exposeMessage?: boolean;
  path?: string;
  issues?: Array<{ path?: PropertyKey[]; message?: string }>;
};

const DATABASE_OUTAGE_ERRORS = new Set(['MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoNotConnectedError', 'MongoTopologyClosedError', 'MongoWaitQueueTimeoutError']);
export const isDatabaseOutage = (err: ErrorLike) => DATABASE_OUTAGE_ERRORS.has(String(err.name)) || /buffering timed out/.test(String(err.message));

function resolveStatus(err: ErrorLike): { statusCode: number; message: string; code?: string } {
  // Nothing was done and the request is safe to repeat: say so, instead of a generic server error
  if (isDatabaseOutage(err)) {
    return { statusCode: 503, message: 'The service is temporarily unavailable. Please try again in a moment.', code: 'SERVICE_UNAVAILABLE' };
  }
  if (err.name === 'CastError') {
    return { statusCode: 400, message: `Invalid ${err.path || 'identifier'} format` };
  }
  if (err.name === 'ValidationError') {
    return { statusCode: 400, message: err.message || 'Validation failed' };
  }
  if (err.name === 'ZodError') {
    const issues = err.issues
      ?.map((issue) => `${issue.path?.join('.') || 'input'}: ${issue.message || 'Invalid value'}`)
      .join('; ');
    return { statusCode: 400, message: issues ? `Validation failed: ${issues}` : 'Validation failed' };
  }
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.message === 'Invalid token type') {
    return { statusCode: 401, message: 'Invalid or expired token' };
  }
  if (err.code === 11000) {
    const keys = Object.keys((err as any).keyPattern || (err as any).keyValue || {});
    if (keys.includes('mobileKey')) return { statusCode: 409, message: 'A guest with this mobile number is already on this event\'s active list.', code: 'DUPLICATE_INVITEE' };
    if (keys.includes('email') && keys.includes('eventId')) return { statusCode: 409, message: 'A guest with this email address is already on this event\'s active list.', code: 'DUPLICATE_INVITEE' };
    // a user's email: one organizer per email is a rule (two requests at once can still meet at the database), but a unique index on
    // the whole email is the OLD rule: it still exists in a database the migration has not been run on
    const detail = String((err as any).errmsg || err.message || '');
    if (keys.length === 1 && keys[0] === 'email' && /uniq_organizer_email/.test(detail)) {
      return { statusCode: 409, message: 'An organizer account already uses this email address.', code: 'ORGANIZER_EMAIL_IN_USE' };
    }
    if (keys.length === 1 && keys[0] === 'email' && /index: email_1\b/.test(detail)) {
      console.error('[users] The database still has the old unique index on users.email (email_1), so a second account on an existing email is refused. Run: npm run migrate:user-contact-uniqueness -- --apply');
      return { statusCode: 409, message: 'This email is already used by another account, and the system has not yet been updated to let one email belong to several accounts. Please ask your administrator to finish the update, then try again.', code: 'USER_EMAIL_INDEX_OUTDATED' };
    }
    return { statusCode: 409, message: 'A record with the same unique value already exists' };
  }
  if (err.type === 'entity.parse.failed') {
    return { statusCode: 400, message: 'Malformed JSON request body' };
  }
  if (err.type === 'entity.too.large') {
    return { statusCode: 413, message: 'Request body is too large' };
  }
  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return { statusCode: 415, message: 'Unsupported request encoding' };
  }
  if (err.name === 'MulterError') {
    return err.code === 'LIMIT_FILE_SIZE'
      ? { statusCode: 413, message: 'Uploaded file is too large' }
      : { statusCode: 400, message: err.message || 'Invalid file upload' };
  }

  const status = [err.statusCode, err.status].find(
    (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599
  );
  if (status !== undefined) {
    return {
      statusCode: status,
      message: status < 500 || err.exposeMessage ? err.message || 'Request failed' : 'Internal Server Error',
      ...(typeof err.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? { code: err.code } : {}),
    };
  }

  return { statusCode: 500, message: 'Internal Server Error' };
}

export const errorHandler: ErrorRequestHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const error = err && typeof err === 'object' ? err as ErrorLike : {};
  const { statusCode, message, code } = resolveStatus(error);

  if (statusCode >= 500) {
    console.error('Error:', error.message || err);
  }

  res.status(statusCode).json({
    success: false,
    ...(code ? { code } : {}),
    message,
    ...(env.NODE_ENV === 'development' && statusCode >= 500 && { stack: error.stack }),
  });
};
