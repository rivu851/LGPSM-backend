import { z } from 'zod';

export const registerSchema = z.object({
  fullName: z.string().min(2, 'Full name must be at least 2 characters'),
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().optional(),
  role: z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
});

// Mobile number is the primary identifier; email remains a valid alternative.
// "At least one of the two" is enforced in authService.login(), not here —
// this route's validate() middleware doesn't surface a top-level `message`
// for Zod refine failures, only the raw field-error tree.
export const loginSchema = z.object({
  email: z.string().email('Invalid email format').optional(),
  phone: z.string().min(4, 'Invalid mobile number').optional(),
  password: z.string().min(1, 'Password is required'),
  role: z.enum(['ADMIN', 'ORGANIZER', 'SYSTEM_USER']).optional(),
});

export const googleAuthSchema = z.object({
  token: z.string().min(1, 'Google ID token is required'),
  // The sign-in portal being used, so a Google account cannot cross into the other portal (same check as password sign-in)
  role: z.enum(['ADMIN', 'ORGANIZER']).optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email format'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

/** Validates the OTP submission from the verify-email page. */
export const verifyEmailSchema = z.object({
  email: z.string().email('Invalid email format'),
  code: z
    .string()
    .length(6, 'Verification code must be exactly 6 digits')
    .regex(/^\d{6}$/, 'Verification code must contain only digits'),
});

/** Validates a resend request. */
export const resendVerificationSchema = z.object({
  email: z.string().email('Invalid email format'),
});
