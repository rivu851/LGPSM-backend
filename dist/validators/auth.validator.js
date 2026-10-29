"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyResetOtpSchema = exports.resendVerificationSchema = exports.verifyEmailSchema = exports.resetPasswordSchema = exports.forgotPasswordSchema = exports.refreshTokenSchema = exports.loginSchema = exports.registerSchema = void 0;
const zod_1 = require("zod");
exports.registerSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2, 'Full name must be at least 2 characters'),
    email: zod_1.z.string().email('Invalid email format'),
    password: zod_1.z.string().min(8, 'Password must be at least 8 characters'),
    phone: zod_1.z.string().optional(),
    role: zod_1.z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
});
// Mobile number is the primary identifier; email remains a valid alternative.
// "At least one of the two" is enforced in authService.login(), not here —
// this route's validate() middleware doesn't surface a top-level `message`
// for Zod refine failures, only the raw field-error tree.
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format').optional(),
    phone: zod_1.z.string().min(4, 'Invalid mobile number').optional(),
    password: zod_1.z.string().min(1, 'Password is required'),
    role: zod_1.z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
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
/** Validates the code submitted in the mobile "Forgot password" flow. */
exports.verifyResetOtpSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format'),
    code: zod_1.z.string().regex(/^\d{4}$/, 'Enter the 4-digit code'),
});
