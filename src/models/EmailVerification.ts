import mongoose, { Document, Schema } from 'mongoose';

/**
 * Stores a hashed 6-digit OTP for organizer email verification.
 *
 * Security notes:
 *  - `codeHash` stores bcrypt(OTP) — the plaintext is never persisted.
 *  - `expiresAt` is validated both by MongoDB's TTL index and in application
 *    code so that replication lag cannot create a window.
 *  - `attempts` tracks wrong guesses; the document is locked (and effectively
 *    invalid) once it reaches MAX_ATTEMPTS.
 *  - `lastSentAt` enforces the 60-second resend cooldown at the model layer.
 *
 * One document per email address (upsert replaces any previous pending code).
 */
export const OTP_EXPIRY_MINUTES = 10;
export const MAX_OTP_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;

export interface IEmailVerification extends Document {
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  lastSentAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailVerificationSchema: Schema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        // Never expose the hash through serialisation
        delete ret.codeHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const EmailVerification = mongoose.model<IEmailVerification>(
  'EmailVerification',
  EmailVerificationSchema
);
