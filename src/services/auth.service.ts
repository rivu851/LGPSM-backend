import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { OAuth2Client } from 'google-auth-library';
import { userRepository } from '../repositories/user.repository';
import { tokenRepository } from '../repositories/token.repository';
import { emailVerificationRepository } from '../repositories/emailVerification.repository';
import { hashPassword, verifyPassword } from '../utils/password';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  generatePasswordResetToken,
  verifyPasswordResetToken,
} from '../utils/token';
import { sendEmail } from '../utils/email.provider';
import { AuthProvider, Role } from '../models/User';
import { MAX_OTP_ATTEMPTS, OTP_EXPIRY_MINUTES } from '../models/EmailVerification';
import { alertService } from './alert.service';
import { env } from '../config/env';

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

// ─── OTP helpers (no plaintext ever leaves this module) ───────────────────────

/** Generates a cryptographically random 6-digit string (zero-padded). */
function generateOtpPlaintext(): string {
  // crypto.randomInt is uniform and cryptographically secure
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

const OTP_HASH_ROUNDS = 10;

async function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, OTP_HASH_ROUNDS);
}

async function verifyOtp(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}

/** Builds and sends the verification email. Returns true on success. */
async function sendVerificationEmail(
  email: string,
  fullName: string,
  otp: string
): Promise<void> {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:8px">
      <h2 style="color:#111827;margin-top:0">Verify your email address</h2>
      <p style="color:#374151">Hello ${fullName},</p>
      <p style="color:#374151">
        Enter the following 6-digit code to verify your LGPSM organizer account.
        The code expires in <strong>${OTP_EXPIRY_MINUTES} minutes</strong>.
      </p>
      <div style="text-align:center;margin:28px 0">
        <span style="display:inline-block;font-size:36px;font-weight:700;letter-spacing:10px;color:#FF651D;background:#fff7f0;padding:16px 24px;border-radius:8px;border:2px solid #FF651D">
          ${otp}
        </span>
      </div>
      <p style="color:#6b7280;font-size:13px">
        If you did not create an account, you can safely ignore this email.
      </p>
    </div>`;

  // sendEmail throws on SMTP failure — callers must handle it
  await sendEmail(email, 'Verify your LGPSM organizer account', html);
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const authService = {
  /**
   * Register a new organizer.
   *
   * On success the account is created with `isEmailVerified: false` and
   * `isActive: false`.  An OTP is generated, hashed, stored, and emailed.
   * If SMTP delivery fails the user record is removed so the caller can retry
   * without creating a duplicate.  No JWT tokens are issued here.
   *
   * Returns `{ pendingVerification: true, email }`.
   */
  async register(data: {
    fullName: string;
    email: string;
    password: string;
    phone?: string;
    role?: string;
  }) {
    const existingUser = await userRepository.findByEmail(data.email);
    if (existingUser) {
      throw { statusCode: 400, message: 'Email already in use' };
    }

    // Self-registration only creates organizers.
    if (data.role && data.role !== Role.ORGANIZER) {
      throw { statusCode: 403, message: 'Only organizer accounts can be self-registered' };
    }

    const hashedPassword = await hashPassword(data.password);

    // Create account as active but unverified (isActive is preserved for administrative activation semantics)
    const user = await userRepository.create({
      fullName: data.fullName,
      email: data.email,
      phone: data.phone,
      passwordHash: hashedPassword,
      authProvider: AuthProvider.LOCAL,
      role: Role.ORGANIZER,
      isActive: true,
      isEmailVerified: false,
    });

    // Generate OTP, hash it, store the hash
    const otp = generateOtpPlaintext();
    const codeHash = await hashOtp(otp);

    try {
      await emailVerificationRepository.createOrReplace(data.email, codeHash);
      await sendVerificationEmail(data.email, data.fullName, otp);
    } catch (err) {
      // SMTP failure → undo account creation so the caller can retry.
      // We do not log or re-throw the OTP.
      await userRepository.deleteByEmail(data.email).catch(() => {});
      await emailVerificationRepository.deleteByEmail(data.email).catch(() => {});
      console.error(
        '[auth.service] Failed to send verification email for',
        data.email,
        ':',
        err instanceof Error ? err.message : 'unknown error'
      );
      throw {
        statusCode: 503,
        message:
          'Unable to send verification email. Please try again later.',
      };
    }

    await alertService.notifyAdmins('newOrganizerRegistration', {
      type: 'SYSTEM',
      title: 'New organizer registered (pending verification)',
      message: `${user.fullName} (${user.email}) created an organizer account and is awaiting email verification.`,
      entityType: 'User',
      entityId: user._id,
    });

    return { pendingVerification: true as const, email: data.email };
  },

  /**
   * Verify an organizer's email address with the 6-digit OTP.
   *
   * Security rules enforced:
   *  1. OTP must exist and not be expired (application-layer check).
   *  2. Hash comparison — plaintext OTP is never stored.
   *  3. Max 5 wrong attempts before the record is effectively locked.
   *  4. On success the OTP record is deleted and the user is activated.
   *
   * On success returns `{ verified: true }`. The caller (frontend) then
   * redirects the user to the sign-in page.  No JWT tokens are issued here.
   */
  async verifyEmail(email: string, code: string) {
    const normalised = email.trim().toLowerCase();

    const record = await emailVerificationRepository.findByEmail(normalised);

    if (!record) {
      throw {
        statusCode: 400,
        message: 'No pending verification found for this email. Please register again.',
      };
    }

    // Application-layer expiry check (belt-and-suspenders alongside TTL index)
    if (record.expiresAt < new Date()) {
      await emailVerificationRepository.deleteByEmail(normalised);
      throw {
        statusCode: 400,
        message: 'Verification code has expired. Please request a new one.',
      };
    }

    // Lock check
    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      throw {
        statusCode: 429,
        message:
          'Too many incorrect attempts. Please request a new verification code.',
      };
    }

    const isMatch = await verifyOtp(code, record.codeHash);

    if (!isMatch) {
      await emailVerificationRepository.incrementAttempts(normalised);
      const remaining = MAX_OTP_ATTEMPTS - (record.attempts + 1);
      throw {
        statusCode: 400,
        message:
          remaining > 0
            ? `Invalid verification code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
            : 'Invalid verification code. You have used all attempts. Please request a new code.',
      };
    }

    // Correct code — mark email as verified
    await userRepository.updateByEmail(normalised, {
      isEmailVerified: true,
    });

    // Remove OTP record
    await emailVerificationRepository.deleteByEmail(normalised);

    return { verified: true as const };
  },

  /**
   * Resend a verification OTP.
   *
   * Rules:
   *  - 60-second cooldown between resends.
   *  - Creates a fresh OTP, replacing the previous one (old code is invalidated).
   *  - If SMTP fails the old hash is NOT restored — caller must retry.
   */
  async resendVerificationCode(email: string) {
    const normalised = email.trim().toLowerCase();

    const user = await userRepository.findByEmail(normalised);

    if (!user || user.role !== Role.ORGANIZER) {
      // Return success-shaped response to avoid email enumeration
      return { sent: true as const };
    }

    if (user.isEmailVerified) {
      throw { statusCode: 400, message: 'This account is already verified.' };
    }

    const cooldown = await emailVerificationRepository.isWithinCooldown(normalised);
    if (cooldown.within) {
      throw {
        statusCode: 429,
        message: `Please wait ${cooldown.secondsRemaining} second${cooldown.secondsRemaining !== 1 ? 's' : ''} before requesting a new code.`,
        secondsRemaining: cooldown.secondsRemaining,
      };
    }

    const otp = generateOtpPlaintext();
    const codeHash = await hashOtp(otp);

    // Send before persisting: if SMTP fails here, the previous (still-delivered)
    // code and its cooldown stay intact instead of being replaced by a code the
    // user never received, which would otherwise leave the account with no
    // working code at all until the next successful resend.
    try {
      await sendVerificationEmail(normalised, user.fullName, otp);
    } catch (err) {
      console.error(
        '[auth.service] Failed to resend verification email to',
        normalised,
        ':',
        err instanceof Error ? err.message : 'unknown error'
      );
      throw {
        statusCode: 503,
        message: 'Unable to send verification email. Please try again later.',
      };
    }

    await emailVerificationRepository.createOrReplace(normalised, codeHash);

    return { sent: true as const };
  },

  /**
   * Login.
   *
   * Additional gate for Organizer accounts:
   *  - If `isEmailVerified === false` → 403 EMAIL_NOT_VERIFIED.
   *  - Admins and System Users are not affected by this gate.
   */
  async login(data: { email: string; password: string; role?: string }) {
    const user = await userRepository.findByEmail(data.email);

    if (!user) {
      throw { statusCode: 401, message: 'Invalid credentials or inactive account' };
    }

    if (user.authProvider !== AuthProvider.LOCAL || !user.passwordHash) {
      throw { statusCode: 401, message: 'Invalid authentication method' };
    }

    const isMatch = await verifyPassword(data.password, user.passwordHash);
    if (!isMatch) {
      throw { statusCode: 401, message: 'Invalid credentials or inactive account' };
    }

    // Role-portal check
    if (data.role && data.role !== user.role) {
      throw {
        statusCode: 403,
        message: `This account is not registered as ${String(data.role).replace('_', ' ').toLowerCase()}. Please use the correct login option.`,
      };
    }

    // Email-verification gate — Organizer only (strictly when isEmailVerified === false for backward compatibility)
    if (user.role === Role.ORGANIZER && user.isEmailVerified === false) {
      throw { statusCode: 403, message: 'EMAIL_NOT_VERIFIED' };
    }

    // Account-activation check (administrative disable, separate from email verification)
    if (!user.isActive) {
      throw { statusCode: 401, message: 'Invalid credentials or inactive account' };
    }

    const userId = (user as any)._id.toString();
    const accessToken = generateAccessToken(userId, user.role);
    const refreshToken = generateRefreshToken(userId, user.role);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await tokenRepository.createRefreshToken(userId, refreshToken, expiresAt);

    return { user, accessToken, refreshToken };
  },

  async googleAuth(idToken: string) {
    if (!env.GOOGLE_CLIENT_ID) {
      throw { statusCode: 501, message: 'Google Auth not configured on server' };
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.email_verified) {
      throw { statusCode: 401, message: 'Invalid or unverified Google token' };
    }

    let user = await userRepository.findByEmail(payload.email);

    if (!user) {
      // Google-authenticated organizers have a verified email by definition
      user = await userRepository.create({
        fullName: payload.name || 'Google User',
        email: payload.email,
        authProvider: AuthProvider.GOOGLE,
        role: Role.ORGANIZER,
        isEmailVerified: true,
        isActive: true,
      });
    } else if (user.authProvider !== AuthProvider.GOOGLE) {
      throw { statusCode: 400, message: 'Email already associated with a local account' };
    }

    if (!user.isActive) {
      throw { statusCode: 403, message: 'User account is inactive' };
    }

    const userId = (user as any)._id.toString();
    const accessToken = generateAccessToken(userId, user.role);
    const refreshToken = generateRefreshToken(userId, user.role);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await tokenRepository.createRefreshToken(userId, refreshToken, expiresAt);

    return { user, accessToken, refreshToken };
  },

  async refresh(token: string) {
    const payload = verifyRefreshToken(token);

    const tokenDoc = await tokenRepository.findByToken(token);
    if (!tokenDoc || tokenDoc.isRevoked || tokenDoc.expiresAt < new Date()) {
      throw { statusCode: 401, message: 'Invalid or expired refresh token' };
    }

    const user = await userRepository.findById(payload.userId);
    if (!user || !user.isActive) {
      throw { statusCode: 401, message: 'User not found or inactive' };
    }

    await tokenRepository.revokeToken(token);

    const userId = (user as any)._id.toString();
    const newAccessToken = generateAccessToken(userId, user.role);
    const newRefreshToken = generateRefreshToken(userId, user.role);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await tokenRepository.createRefreshToken(userId, newRefreshToken, expiresAt);

    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  },

  async logout(token: string) {
    if (token) {
      await tokenRepository.revokeToken(token);
    }
  },

  async forgotPassword(email: string) {
    const user = await userRepository.findByEmail(email);
    if (!user) return;

    const resetToken = generatePasswordResetToken((user as any)._id.toString(), user.role);
    const portal = user.role === Role.ADMIN ? 'admin' : user.role === Role.ORGANIZER ? 'organizer' : 'app';
    const resetUrl = `${env.FRONTEND_URL}/forgot-password?mode=${portal}&token=${encodeURIComponent(resetToken)}`;

    try {
      await sendEmail(
        user.email,
        'Reset your LGPSM password',
        `<p>Hello ${user.fullName},</p><p>Use the link below to reset your password. It expires in 15 minutes.</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`
      );
    } catch (err) {
      console.error('Password reset email could not be sent:', (err as Error).message);
    }
  },

  async resetPassword(token: string, newPassword: string) {
    const payload = verifyPasswordResetToken(token);

    const user = await userRepository.findById(payload.userId);
    if (!user) {
      throw { statusCode: 400, message: 'Invalid token' };
    }

    const hashedPassword = await hashPassword(newPassword);
    await userRepository.updateById((user as any)._id.toString(), {
      passwordHash: hashedPassword,
    });

    await tokenRepository.revokeAllForUser((user as any)._id.toString());
  },
};
