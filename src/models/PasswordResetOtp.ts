import mongoose, { Document, Schema } from 'mongoose';

/**
 * A pending password-reset code (mobile "Forgot password" flow).
 *
 *  - `codeHash` is bcrypt(code); the plaintext is only ever emailed, never stored.
 *  - `expiresAt` is enforced by the TTL index and again in code.
 *  - `attempts` counts wrong guesses; the code is dead after MAX_RESET_OTP_ATTEMPTS and a fresh one must be requested.
 *  - `lastSentAt` backs the resend cooldown.
 * One document per email: requesting a new code replaces the previous one.
 */
export const RESET_OTP_LENGTH = 4;
export const RESET_OTP_EXPIRY_MINUTES = 10;
export const MAX_RESET_OTP_ATTEMPTS = 5;
export const RESET_OTP_RESEND_COOLDOWN_SECONDS = 30;

export interface IPasswordResetOtp extends Document {
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  lastSentAt: Date;
}

const PasswordResetOtpSchema = new Schema<IPasswordResetOtp>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
  },
  { timestamps: true }
);

export const PasswordResetOtp = mongoose.model<IPasswordResetOtp>('PasswordResetOtp', PasswordResetOtpSchema);
