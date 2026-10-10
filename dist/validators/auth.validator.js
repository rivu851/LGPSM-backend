"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resendVerificationSchema = exports.verifyEmailSchema = exports.resetPasswordSchema = exports.forgotPasswordSchema = exports.refreshTokenSchema = exports.googleAuthSchema = exports.loginSchema = exports.registerSchema = void 0;
const zod_1 = require("zod");
exports.registerSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2, 'Full name must be at least 2 characters'),
    email: zod_1.z.string().email('Invalid email format'),
    password: zod_1.z.string().min(8, 'Password must be at least 8 characters'),
    phone: zod_1.z.string().optional(),
    role: zod_1.z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
});
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format'),
    password: zod_1.z.string().min(1, 'Password is required'),
    role: zod_1.z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
});
exports.googleAuthSchema = zod_1.z.object({
    token: zod_1.z.string().min(1, 'Google ID token is required'),
});
exports.refreshTokenSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(1, 'Refresh token is required'),
});
exports.forgotPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format'),
});
exports.resetPasswordSchema = zod_1.z.object({
    token: zod_1.z.string().min(1, 'Reset token is required'),
    newPassword: zod_1.z.string().min(8, 'Password must be at least 8 characters'),
});
/** Validates the OTP submission from the verify-email page. */
exports.verifyEmailSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format'),
    code: zod_1.z
        .string()
        .length(6, 'Verification code must be exactly 6 digits')
        .regex(/^\d{6}$/, 'Verification code must contain only digits'),
});
/** Validates a resend request. */
exports.resendVerificationSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format'),
});
