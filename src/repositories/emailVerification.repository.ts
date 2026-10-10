import {
  EmailVerification,
  IEmailVerification,
  OTP_EXPIRY_MINUTES,
  RESEND_COOLDOWN_SECONDS,
} from '../models/EmailVerification';

export const emailVerificationRepository = {
  /**
   * Creates a new OTP record for the given email, replacing any previous one
   * (one valid pending OTP per account at any time).
   *
   * @param email      Normalised (lowercase) email address.
   * @param codeHash   bcrypt hash of the 6-digit OTP.
   */
  async createOrReplace(email: string, codeHash: string): Promise<IEmailVerification> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000);

    return EmailVerification.findOneAndReplace(
      { email },
      {
        email,
        codeHash,
        expiresAt,
        attempts: 0,
        lastSentAt: now,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ) as unknown as IEmailVerification;
  },

  /**
   * Finds an OTP record that has not yet expired (application-layer check,
   * independent of the MongoDB TTL index).
   */
  async findValidByEmail(email: string): Promise<IEmailVerification | null> {
    return EmailVerification.findOne({
      email,
      expiresAt: { $gt: new Date() },
    });
  },

  /**
   * Finds any record (including those past `expiresAt`) so that callers can
   * distinguish "wrong code" from "expired" gracefully.
   */
  async findByEmail(email: string): Promise<IEmailVerification | null> {
    return EmailVerification.findOne({ email });
  },

  /** Increments the failed-attempt counter in a single atomic operation. */
  async incrementAttempts(email: string): Promise<void> {
    await EmailVerification.updateOne({ email }, { $inc: { attempts: 1 } });
  },

  /** Removes the OTP record after successful verification. */
  async deleteByEmail(email: string): Promise<void> {
    await EmailVerification.deleteOne({ email });
  },

  /**
   * Returns true when the account is within its 60-second resend cooldown.
   * Compares `lastSentAt` (stored on the document) against the current time.
   */
  async isWithinCooldown(email: string): Promise<{ within: boolean; secondsRemaining: number }> {
    const doc = await EmailVerification.findOne({ email }, { lastSentAt: 1 });
    if (!doc) return { within: false, secondsRemaining: 0 };
    const elapsed = (Date.now() - doc.lastSentAt.getTime()) / 1000;
    const remaining = Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed);
    return remaining > 0
      ? { within: true, secondsRemaining: remaining }
      : { within: false, secondsRemaining: 0 };
  },
};
