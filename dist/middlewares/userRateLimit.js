"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GENERAL_USER_LIMIT = void 0;
exports.consumeUserLimit = consumeUserLimit;
exports.perUserLimit = perUserLimit;
exports.dedupeWindow = dedupeWindow;
const crypto_1 = __importDefault(require("crypto"));
const express_rate_limit_1 = require("express-rate-limit");
const kv_1 = require("../infra/kv");
const securityLog_1 = require("../utils/securityLog");
// Off under test unless a test opts in (like the other limiters), so a suite is never slowed or refused by a limit it is not testing
const skip = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_TESTS !== 'true';
const who = (req) => req.user?.userId ? `u:${req.user.userId}` : `ip:${(0, express_rate_limit_1.ipKeyGenerator)(req.ip || '')}`;
function refuse(req, res, name, windowMs, ttlMs, max, message) {
    const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
    (0, securityLog_1.securityEvent)('RATE_LIMITED', req, { limiter: name });
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
async function consumeUserLimit(req, res, name, opts) {
    if (skip())
        return true;
    try {
        const { count, ttlMs } = await kv_1.kv.incr(`ul:${name}:${who(req)}`, opts.windowMs);
        res.setHeader('RateLimit-Limit', String(opts.max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.max - count)));
        if (count > opts.max) {
            refuse(req, res, name, opts.windowMs, ttlMs, opts.max, opts.message);
            return false;
        }
    }
    catch {
        // the counter store is out of reach: a limit must never take the app down
    }
    return true;
}
/**
 * At most `max` requests per `windowMs` for each signed-in person (each address when there is no sign-in), counted per `name`. Stops one
 * account from hammering an endpoint, however many devices or addresses it uses. The count expires by itself when the window ends.
 */
function perUserLimit(name, opts) {
    return async (req, res, next) => {
        if (await consumeUserLimit(req, res, name, opts))
            next();
    };
}
/** Used by `authenticate`: every signed-in request counts toward one generous ceiling per person (10 a second on average) */
exports.GENERAL_USER_LIMIT = { windowMs: 60_000, max: 600, message: 'Too many requests. Please slow down and try again in a moment.' };
/**
 * Refuses the exact same request (same person, same address, same body) arriving again within `ttlMs`: a double tap, or a retry loop.
 * A request that fails is forgotten at once, so the person can correct it and try again without waiting.
 */
function dedupeWindow(name, ttlMs) {
    return async (req, res, next) => {
        if (skip())
            return next();
        let key = '';
        try {
            const fingerprint = crypto_1.default.createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path} ${JSON.stringify(req.body ?? {})} ${JSON.stringify(req.query ?? {})}`).digest('hex').slice(0, 32);
            key = `dd:${name}:${who(req)}:${fingerprint}`;
            if (!(await kv_1.kv.setNX(key, '1', ttlMs))) {
                const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
                res.setHeader('Retry-After', String(seconds));
                res.status(429).json({ success: false, code: 'DUPLICATE_REQUEST', retryAfterSeconds: seconds, message: 'That request was just received. Please wait a moment before trying again.' });
                return;
            }
        }
        catch {
            return next();
        }
        res.on('finish', () => { if (res.statusCode >= 400)
            void kv_1.kv.del(key).catch(() => undefined); });
        next();
    };
}
