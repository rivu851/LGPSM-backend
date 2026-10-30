import type { Request } from 'express';
import { redactTokens } from './redact';

// Structured security events: one JSON object per line on stdout, so a log drain / SIEM can filter on
// `"channel":"security"` and alert on event names. This is logging only; alerting must be configured
// in the hosting platform (see security-reports/E_monitoring_plan.md).
//
// Never put credentials in an event. Keys that look sensitive are dropped and values are truncated, so
// a caller passing the wrong object cannot leak a password, OTP, token or secret into the logs.

export type SecurityEvent =
  | 'AUTH_TOKEN_REJECTED'
  | 'AUTH_INACTIVE_USER'
  | 'AUTHZ_DENIED'
  | 'LOGIN_FAILED'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'PAYMENT_SIGNATURE_INVALID'
  | 'RATE_LIMITED'
  | 'SSRF_BLOCKED'
  | 'TEMPLATE_GENERATION_DENIED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET_COMPLETED'
  | 'PASSWORD_RESET_OTP_FAILED';

const SENSITIVE_KEY = /pass(word)?|token|secret|otp|code|authorization|cookie|signature|key|credential/i;
const MAX_VALUE_LENGTH = 120;

export function sanitizeDetail(detail: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, MAX_VALUE_LENGTH).replace(/[\r\n]+/g, ' ');
  }
  return out;
}

export function securityEvent(event: SecurityEvent, req?: Request, detail?: Record<string, unknown>): void {
  if (process.env.NODE_ENV === 'test' && process.env.SECURITY_LOG_IN_TEST !== 'true') return;
  const line = {
    ts: new Date().toISOString(),
    channel: 'security',
    event,
    ...(req
      ? {
          ip: req.ip,
          method: req.method,
          // Route only: the query string can carry tokens
          path: redactTokens((req.originalUrl || req.url || '').split('?')[0]).slice(0, 200),
          userId: req.user?.userId,
          role: req.user?.role
        }
      : {}),
    ...sanitizeDetail(detail)
  };
  console.log(JSON.stringify(line));
}
