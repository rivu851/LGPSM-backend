"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeAuditMetadata = void 0;
exports.sanitizeAuditValue = sanitizeAuditValue;
// Audit metadata is stored for a long time and shown to organizers and admins, so it is built from an allow-by-shape
// pass: anything that looks like a credential is dropped, long text is cut, and depth/size are bounded.
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|api[-_]?key|cookie|qr|cipher|hash|otp|signature|credential/i;
const MAX_STRING = 200;
const MAX_KEYS = 30;
const MAX_DEPTH = 3;
function sanitizeAuditValue(value, depth = 0) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === 'string')
        return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (value instanceof Date)
        return value.toISOString();
    if (depth >= MAX_DEPTH)
        return '[truncated]';
    if (Array.isArray(value))
        return value.slice(0, 10).map((v) => sanitizeAuditValue(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value).slice(0, MAX_KEYS)) {
            if (SENSITIVE_KEY.test(k))
                continue;
            out[k] = sanitizeAuditValue(v, depth + 1);
        }
        return out;
    }
    return undefined;
}
const sanitizeAuditMetadata = (meta) => sanitizeAuditValue(meta || {}) || {};
exports.sanitizeAuditMetadata = sanitizeAuditMetadata;
