"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const google_auth_library_1 = require("google-auth-library");
const user_repository_1 = require("../repositories/user.repository");
const token_repository_1 = require("../repositories/token.repository");
const emailVerification_repository_1 = require("../repositories/emailVerification.repository");
const password_1 = require("../utils/password");
const token_1 = require("../utils/token");
const email_provider_1 = require("../utils/email.provider");
const User_1 = require("../models/User");
const EmailVerification_1 = require("../models/EmailVerification");
const alert_service_1 = require("./alert.service");
const env_1 = require("../config/env");
const googleClient = new google_auth_library_1.OAuth2Client(env_1.env.GOOGLE_CLIENT_ID);
// ─── OTP helpers (no plaintext ever leaves this module) ───────────────────────
/** Generates a cryptographically random 6-digit string (zero-padded). */
function generateOtpPlaintext() {
    // crypto.randomInt is uniform and cryptographically secure
    const n = crypto_1.default.randomInt(0, 1_000_000);
    return n.toString().padStart(6, '0');
}
const OTP_HASH_ROUNDS = 10;
async function hashOtp(otp) {
    return bcrypt_1.default.hash(otp, OTP_HASH_ROUNDS);
}
async function verifyOtp(otp, hash) {
    return bcrypt_1.default.compare(otp, hash);
}
/** Builds and sends the verification email. Returns true on success. */
async function sendVerificationEmail(email, fullName, otp) {
    const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:8px">
      <h2 style="color:#111827;margin-top:0">Verify your email address</h2>
      <p style="color:#374151">Hello ${fullName},</p>
      <p style="color:#374151">
        Enter the following 6-digit code to verify your LGPSM organizer account.
        The code expires in <strong>${EmailVerification_1.OTP_EXPIRY_MINUTES} minutes</strong>.
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
    await (0, email_provider_1.sendEmail)(email, 'Verify your LGPSM organizer account', html);
}
// ─── Service ──────────────────────────────────────────────────────────────────
exports.authService = {
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
    async register(data) {
        const existingUser = await user_repository_1.userRepository.findByEmail(data.email);
        if (existingUser) {
            throw { statusCode: 400, message: 'Email already in use' };
        }
        // Self-registration only creates organizers.
        if (data.role && data.role !== User_1.Role.ORGANIZER) {
            throw { statusCode: 403, message: 'Only organizer accounts can be self-registered' };
        }
        const hashedPassword = await (0, password_1.hashPassword)(data.password);
        // Create account as active but unverified (isActive is preserved for administrative activation semantics)
        const user = await user_repository_1.userRepository.create({
            fullName: data.fullName,
            email: data.email,
            phone: data.phone,
            passwordHash: hashedPassword,
            authProvider: User_1.AuthProvider.LOCAL,
            role: User_1.Role.ORGANIZER,
            isActive: true,
            isEmailVerified: false,
        });
        // Generate OTP, hash it, store the hash
        const otp = generateOtpPlaintext();
        const codeHash = await hashOtp(otp);
        try {
            await emailVerification_repository_1.emailVerificationRepository.createOrReplace(data.email, codeHash);
            await sendVerificationEmail(data.email, data.fullName, otp);
        }
        catch (err) {
            // SMTP failure → undo account creation so the caller can retry.
            // We do not log or re-throw the OTP.
            await user_repository_1.userRepository.deleteByEmail(data.email).catch(() => { });
            await emailVerification_repository_1.emailVerificationRepository.deleteByEmail(data.email).catch(() => { });
            console.error('[auth.service] Failed to send verification email for', data.email, ':', err instanceof Error ? err.message : 'unknown error');
            throw {
                statusCode: 503,
                message: 'Unable to send verification email. Please try again later.',
            };
        }
        await alert_service_1.alertService.notifyAdmins('newOrganizerRegistration', {
            type: 'SYSTEM',
            title: 'New organizer registered (pending verification)',
            message: `${user.fullName} (${user.email}) created an organizer account and is awaiting email verification.`,
            entityType: 'User',
            entityId: user._id,
        });
        return { pendingVerification: true, email: data.email };
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
    async verifyEmail(email, code) {
        const normalised = email.trim().toLowerCase();
        const record = await emailVerification_repository_1.emailVerificationRepository.findByEmail(normalised);
        if (!record) {
            throw {
                statusCode: 400,
                message: 'No pending verification found for this email. Please register again.',
            };
        }
        // Application-layer expiry check (belt-and-suspenders alongside TTL index)
        if (record.expiresAt < new Date()) {
            await emailVerification_repository_1.emailVerificationRepository.deleteByEmail(normalised);
            throw {
                statusCode: 400,
                message: 'Verification code has expired. Please request a new one.',
            };
        }
        // Lock check
        if (record.attempts >= EmailVerification_1.MAX_OTP_ATTEMPTS) {
            throw {
                statusCode: 429,
                message: 'Too many incorrect attempts. Please request a new verification code.',
            };
        }
        const isMatch = await verifyOtp(code, record.codeHash);
        if (!isMatch) {
            await emailVerification_repository_1.emailVerificationRepository.incrementAttempts(normalised);
            const remaining = EmailVerification_1.MAX_OTP_ATTEMPTS - (record.attempts + 1);
            throw {
                statusCode: 400,
                message: remaining > 0
                    ? `Invalid verification code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
                    : 'Invalid verification code. You have used all attempts. Please request a new code.',
            };
        }
        // Correct code — mark email as verified
        await user_repository_1.userRepository.updateByEmail(normalised, {
            isEmailVerified: true,
        });
        // Remove OTP record
        await emailVerification_repository_1.emailVerificationRepository.deleteByEmail(normalised);
        return { verified: true };
    },
    /**
     * Resend a verification OTP.
     *
     * Rules:
     *  - 60-second cooldown between resends.
     *  - Creates a fresh OTP, replacing the previous one (old code is invalidated).
     *  - If SMTP fails the old hash is NOT restored — caller must retry.
     */
    async resendVerificationCode(email) {
        const normalised = email.trim().toLowerCase();
        const user = await user_repository_1.userRepository.findByEmail(normalised);
        if (!user || user.role !== User_1.Role.ORGANIZER) {
            // Return success-shaped response to avoid email enumeration
            return { sent: true };
        }
        if (user.isEmailVerified) {
            throw { statusCode: 400, message: 'This account is already verified.' };
        }
        const cooldown = await emailVerification_repository_1.emailVerificationRepository.isWithinCooldown(normalised);
        if (cooldown.within) {
            throw {
                statusCode: 429,
                message: `Please wait ${cooldown.secondsRemaining} second${cooldown.secondsRemaining !== 1 ? 's' : ''} before requesting a new code.`,
                secondsRemaining: cooldown.secondsRemaining,
            };
        }
        const otp = generateOtpPlaintext();
        const codeHash = await hashOtp(otp);
        await emailVerification_repository_1.emailVerificationRepository.createOrReplace(normalised, codeHash);
        try {
            await sendVerificationEmail(normalised, user.fullName, otp);
        }
        catch (err) {
            console.error('[auth.service] Failed to resend verification email to', normalised, ':', err instanceof Error ? err.message : 'unknown error');
            throw {
                statusCode: 503,
                message: 'Unable to send verification email. Please try again later.',
            };
        }
        return { sent: true };
    },
    /**
     * Login.
     *
     * Additional gate for Organizer accounts:
     *  - If `isEmailVerified === false` → 403 EMAIL_NOT_VERIFIED.
     *  - Admins and System Users are not affected by this gate.
     */
    async login(data) {
        const user = await user_repository_1.userRepository.findByEmail(data.email);
        if (!user) {
            throw { statusCode: 401, message: 'Invalid credentials or inactive account' };
        }
        if (user.authProvider !== User_1.AuthProvider.LOCAL || !user.passwordHash) {
            throw { statusCode: 401, message: 'Invalid authentication method' };
        }
        const isMatch = await (0, password_1.verifyPassword)(data.password, user.passwordHash);
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
        if (user.role === User_1.Role.ORGANIZER && user.isEmailVerified === false) {
            throw { statusCode: 403, message: 'EMAIL_NOT_VERIFIED' };
        }
        // Account-activation check (administrative disable, separate from email verification)
        if (!user.isActive) {
            throw { statusCode: 401, message: 'Invalid credentials or inactive account' };
        }
        const userId = user._id.toString();
        const accessToken = (0, token_1.generateAccessToken)(userId, user.role);
        const refreshToken = (0, token_1.generateRefreshToken)(userId, user.role);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await token_repository_1.tokenRepository.createRefreshToken(userId, refreshToken, expiresAt);
        return { user, accessToken, refreshToken };
    },
    async googleAuth(idToken) {
        if (!env_1.env.GOOGLE_CLIENT_ID) {
            throw { statusCode: 501, message: 'Google Auth not configured on server' };
        }
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: env_1.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload || !payload.email || !payload.email_verified) {
            throw { statusCode: 401, message: 'Invalid or unverified Google token' };
        }
        let user = await user_repository_1.userRepository.findByEmail(payload.email);
        if (!user) {
            // Google-authenticated organizers have a verified email by definition
            user = await user_repository_1.userRepository.create({
                fullName: payload.name || 'Google User',
                email: payload.email,
                authProvider: User_1.AuthProvider.GOOGLE,
                role: User_1.Role.ORGANIZER,
                isEmailVerified: true,
                isActive: true,
            });
        }
        else if (user.authProvider !== User_1.AuthProvider.GOOGLE) {
            throw { statusCode: 400, message: 'Email already associated with a local account' };
        }
        if (!user.isActive) {
            throw { statusCode: 403, message: 'User account is inactive' };
        }
        const userId = user._id.toString();
        const accessToken = (0, token_1.generateAccessToken)(userId, user.role);
        const refreshToken = (0, token_1.generateRefreshToken)(userId, user.role);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await token_repository_1.tokenRepository.createRefreshToken(userId, refreshToken, expiresAt);
        return { user, accessToken, refreshToken };
    },
    async refresh(token) {
        const payload = (0, token_1.verifyRefreshToken)(token);
        const tokenDoc = await token_repository_1.tokenRepository.findByToken(token);
        if (!tokenDoc || tokenDoc.isRevoked || tokenDoc.expiresAt < new Date()) {
            throw { statusCode: 401, message: 'Invalid or expired refresh token' };
        }
        const user = await user_repository_1.userRepository.findById(payload.userId);
        if (!user || !user.isActive) {
            throw { statusCode: 401, message: 'User not found or inactive' };
        }
        await token_repository_1.tokenRepository.revokeToken(token);
        const userId = user._id.toString();
        const newAccessToken = (0, token_1.generateAccessToken)(userId, user.role);
        const newRefreshToken = (0, token_1.generateRefreshToken)(userId, user.role);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await token_repository_1.tokenRepository.createRefreshToken(userId, newRefreshToken, expiresAt);
        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    },
    async logout(token) {
        if (token) {
            await token_repository_1.tokenRepository.revokeToken(token);
        }
    },
    async forgotPassword(email) {
        const user = await user_repository_1.userRepository.findByEmail(email);
        if (!user)
            return;
        const resetToken = (0, token_1.generatePasswordResetToken)(user._id.toString(), user.role);
        const portal = user.role === User_1.Role.ADMIN ? 'admin' : user.role === User_1.Role.ORGANIZER ? 'organizer' : 'app';
        const resetUrl = `${env_1.env.FRONTEND_URL}/forgot-password?mode=${portal}&token=${encodeURIComponent(resetToken)}`;
        try {
            await (0, email_provider_1.sendEmail)(user.email, 'Reset your LGPSM password', `<p>Hello ${user.fullName},</p><p>Use the link below to reset your password. It expires in 15 minutes.</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`);
        }
        catch (err) {
            console.error('Password reset email could not be sent:', err.message);
        }
    },
    async resetPassword(token, newPassword) {
        const payload = (0, token_1.verifyPasswordResetToken)(token);
        const user = await user_repository_1.userRepository.findById(payload.userId);
        if (!user) {
            throw { statusCode: 400, message: 'Invalid token' };
        }
        const hashedPassword = await (0, password_1.hashPassword)(newPassword);
        await user_repository_1.userRepository.updateById(user._id.toString(), {
            passwordHash: hashedPassword,
        });
        await token_repository_1.tokenRepository.revokeAllForUser(user._id.toString());
    },
};
