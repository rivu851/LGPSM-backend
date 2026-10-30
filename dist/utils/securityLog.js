"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeDetail = sanitizeDetail;
exports.securityEvent = securityEvent;
const redact_1 = require("./redact");
const SENSITIVE_KEY = /pass(word)?|token|secret|otp|code|authorization|cookie|signature|key|credential/i;
const MAX_VALUE_LENGTH = 120;
function sanitizeDetail(detail = {}) {
    const out = {};
    for (const [key, value] of Object.entries(detail)) {
        if (SENSITIVE_KEY.test(key))
            continue;
        if (typeof value === 'number' || typeof value === 'boolean')
            out[key] = value;
        else if (typeof value === 'string')
            out[key] = value.slice(0, MAX_VALUE_LENGTH).replace(/[\r\n]+/g, ' ');
    }
    return out;
}
function securityEvent(event, req, detail) {
    if (process.env.NODE_ENV === 'test' && process.env.SECURITY_LOG_IN_TEST !== 'true')
        return;
    const line = {
        ts: new Date().toISOString(),
        channel: 'security',
        event,
        ...(req
            ? {
                ip: req.ip,
                method: req.method,
                // Route only: the query string can carry tokens
                path: (0, redact_1.redactTokens)((req.originalUrl || req.url || '').split('?')[0]).slice(0, 200),
                userId: req.user?.userId,
                role: req.user?.role
            }
            : {}),
        ...sanitizeDetail(detail)
    };
    console.log(JSON.stringify(line));
}
