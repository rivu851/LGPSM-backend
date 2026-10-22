"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateRenderLimiter = exports.templateGenerationReadLimiter = exports.templateGenerationLimiter = exports.cardPreviewLimiter = exports.publicInvitationLimiter = exports.contactRateLimiter = exports.contactAttemptLimiter = exports.resendVerificationRateLimiter = exports.verifyEmailRateLimiter = exports.authRateLimiter = void 0;
const express_rate_limit_1 = __importStar(require("express-rate-limit"));
const securityLog_1 = require("../utils/securityLog");
// Records every throttled request as a security event, then answers exactly as the default handler would
const logged = (limiter) => (req, res, _next, options) => {
    (0, securityLog_1.securityEvent)('RATE_LIMITED', req, { limiter });
    res.status(options.statusCode).send(options.message);
};
/** 20 requests per 15 minutes per IP — applied to all auth endpoints. */
exports.authRateLimiter = (0, express_rate_limit_1.default)({
    handler: logged('authRateLimiter'),
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, message: 'Too many requests from this IP, please try again after 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
});
/**
 * Strict limiter for OTP verification — 10 attempts per 10 minutes per IP.
 * This is separate from the account-level attempt counter in the service layer.
 */
exports.verifyEmailRateLimiter = (0, express_rate_limit_1.default)({
    handler: logged('verifyEmailRateLimiter'),
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many verification attempts. Please try again in 10 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
});
/**
 * Resend limiter — 5 resend requests per 10 minutes per IP.
 * The 60-second account-level cooldown is enforced separately in the service.
 */
exports.resendVerificationRateLimiter = (0, express_rate_limit_1.default)({
    handler: logged('resendVerificationRateLimiter'),
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Too many resend requests. Please try again in 10 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
});
/**
 * Public contact form, two layers (in-memory stores: per server instance, which matches the single
 * Render instance this API runs on). Both are skipped under test unless a test opts in with
 * ENABLE_RATE_LIMIT_TESTS, so rate limiting itself can be tested without slowing other suites.
 *
 * - Attempts: 30 requests / 15 min / IP counting everything, so invalid-payload hammering is bounded.
 * - Submissions: 5 / 15 min / IP counting only requests that were accepted (skipFailedRequests), so a
 *   visitor correcting validation mistakes is not locked out.
 */
const skipInTest = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_TESTS !== 'true';
exports.contactAttemptLimiter = (0, express_rate_limit_1.default)({
    handler: logged('contactAttemptLimiter'),
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { success: false, message: 'Too many requests from this network. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipInTest,
});
exports.contactRateLimiter = (0, express_rate_limit_1.default)({
    handler: logged('contactRateLimiter'),
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Too many messages sent from this network. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    skip: skipInTest,
});
/**
 * Public invitation pages and RSVP (token in the URL). Tokens are 256-bit random so guessing is not
 * feasible; this bounds scraping and request floods against an unauthenticated route. The ceiling is
 * generous because many guests can share one venue network.
 */
exports.publicInvitationLimiter = (0, express_rate_limit_1.default)({
    handler: logged('publicInvitationLimiter'),
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { success: false, message: 'Too many requests from this network. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipInTest,
});
/**
 * Live card preview in the Add Event form: rendering an image is far more expensive than a normal request, and the
 * form asks again as the organizer types (debounced), so the ceiling allows steady typing but not a flood.
 */
exports.cardPreviewLimiter = (0, express_rate_limit_1.default)({
    handler: logged('cardPreviewLimiter'),
    windowMs: 60 * 1000,
    max: 60,
    message: { success: false, message: 'Too many preview requests. Please wait a moment.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipInTest,
});
// Keyed by the signed-in user (these routes always sit behind authenticate), so one organizer cannot spend another's allowance
const perUser = (req) => req.user?.userId || (0, express_rate_limit_1.ipKeyGenerator)(req.ip);
/** Starting a generation costs real provider quota: 10 requests per hour per user (the per-day quota is enforced by the service). */
exports.templateGenerationLimiter = (0, express_rate_limit_1.default)({
    handler: logged('templateGenerationLimiter'),
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyGenerator: perUser,
    message: { success: false, code: 'RATE_LIMITED', message: 'Too many design requests. Please wait before generating again.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipInTest,
});
/** Status polling and previews: generous, because the apps poll while a design is being made. */
exports.templateGenerationReadLimiter = (0, express_rate_limit_1.default)({
    handler: logged('templateGenerationReadLimiter'),
    windowMs: 60 * 1000,
    max: 120,
    keyGenerator: perUser,
    message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipInTest,
});
/** Full-size renders are heavier than previews. */
exports.templateRenderLimiter = (0, express_rate_limit_1.default)({
    handler: logged('templateRenderLimiter'),
    windowMs: 60 * 1000,
    max: 20,
    keyGenerator: perUser,
    message: { success: false, message: 'Too many image requests. Please wait a moment.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipInTest,
});
