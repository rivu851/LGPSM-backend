"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resendVerificationRateLimiter = exports.verifyEmailRateLimiter = exports.authRateLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
/** 20 requests per 15 minutes per IP — applied to all auth endpoints. */
exports.authRateLimiter = (0, express_rate_limit_1.default)({
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
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Too many resend requests. Please try again in 10 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
});
