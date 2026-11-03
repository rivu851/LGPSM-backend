import mongoose, { Document, Schema } from 'mongoose';

/**
 * Per-account limits for the short emailed reset code, kept apart from the code itself because the code's own record disappears when it
 * expires or is replaced. A 4-digit code is only safe with a small total number of guesses, whatever IP addresses they come from.
 * The record removes itself 24 hours after it was started.
 */
export const RESET_THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_RESET_GUESSES_PER_WINDOW = 10;
export const MAX_RESET_CODES_PER_WINDOW = 10;

export interface IPasswordResetThrottle extends Document {
  email: string;
  failedGuesses: number;
  codesSent: number;
  purgeAt: Date;
}

const PasswordResetThrottleSchema = new Schema<IPasswordResetThrottle>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  failedGuesses: { type: Number, default: 0 },
  codesSent: { type: Number, default: 0 },
  purgeAt: { type: Date, required: true, index: { expires: 0 } },
});

export const PasswordResetThrottle = mongoose.model<IPasswordResetThrottle>('PasswordResetThrottle', PasswordResetThrottleSchema);
