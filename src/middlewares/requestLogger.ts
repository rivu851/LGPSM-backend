import morgan from 'morgan';
import type { Request } from 'express';
import { redactTokens } from '../utils/redact';

// Per-request log line (method, path, status, time) with tokens removed from the path. The query string is not logged.
morgan.token('safe-url', (req: Request) => redactTokens(String(req.originalUrl || req.url || '').split('?')[0]));
export const requestLogger = (stream?: { write: (line: string) => void }) =>
  morgan(':method :safe-url :status :response-time ms', stream ? { stream } : undefined);
