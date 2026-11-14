"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyResetOtpSchema = exports.changePendingEmailSchema = exports.resendVerificationSchema = exports.verifyEmailSchema = exports.resetPasswordSchema = exports.forgotPasswordSchema = exports.refreshTokenSchema = exports.loginSchema = exports.registerSchema = void 0;
const zod_1 = require("zod");
const phone_validator_1 = require("./phone.validator");
exports.registerSchema = zod_1.z.object({
    fullName: zod_1.z.string().trim().min(2, 'Full name must be at least 2 characters').max(120, 'Full name is too long'),
    email: zod_1.z.string().trim().toLowerCase().email('Invalid email format'),
    password: zod_1.z.string().min(8, 'Password must be at least 8 characters'),
    phone: phone_validator_1.optionalPhoneSchema,
    role: zod_1.z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
    organizationType: zod_1.z.enum(['INDIVIDUAL', 'ORGANIZATION']).optional(),
    organizationName: zod_1.z.string().trim().max(150, 'Organization name is too long').optional(),
    // How the organizer will send invitations (asked at signup); the send screen starts with this choice
    invitationChannel: zod_1.z.enum(['EMAIL', 'WHATSAPP', 'BOTH']).optional(),
}).superRefine((data, ctx) => {
    if (data.organizationType === 'ORGANIZATION' && (data.organizationName?.length ?? 0) < 2) {
        ctx.addIssue({
            code: 'custom',
            path: ['organizationName'],
            message: 'Organization name must be at least 2 characters',
        });
    }
});
// Mobile number is the primary identifier; email remains a valid alternative.
// "At least one of the two" is enforced in authService.login(), not here —
// this route's validate() middleware doesn't surface a top-level `message`
// for Zod refine failures, only the raw field-error tree.
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format').optional(),
    phone: phone_validator_1.optionalPhoneSchema,
    password: zod_1.z.string().min(1, 'Password is required'),
    role: zod_1.z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
});
exports.refreshTokenSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(1, 'Refresh token is required'),
});
exports.forgotPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format'),
    /** the portal asking, when an email is shared by several accounts (mobile app: SYSTEM_USER) */
    role: zod_1.z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
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
/** "Change email address" on the sign-up code page: the address the code went to, the corrected one, and the password chosen in step 1 */
exports.changePendingEmailSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format'),
    newEmail: zod_1.z.string().trim().email('Enter a valid email address'),
    password: zod_1.z.string().min(1, 'Enter the password you chose'),
});
/** Validates the code submitted in the mobile "Forgot password" flow. */
exports.verifyResetOtpSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format'),
    code: zod_1.z.string().regex(/^\d{4}$/, 'Enter the 4-digit code'),
    role: zod_1.z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
});
