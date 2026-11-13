"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const user_repository_1 = require("../repositories/user.repository");
const securityLog_1 = require("../utils/securityLog");
const token_repository_1 = require("../repositories/token.repository");
const emailVerification_repository_1 = require("../repositories/emailVerification.repository");
const password_1 = require("../utils/password");
const token_1 = require("../utils/token");
const email_provider_1 = require("../utils/email.provider");
const User_1 = require("../models/User");
const EmailVerification_1 = require("../models/EmailVerification");
const PasswordResetOtp_1 = require("../models/PasswordResetOtp");
const alert_service_1 = require("./alert.service");
const env_1 = require("../config/env");
const whatsapp_service_1 = require("./whatsapp.service");
const html_1 = require("../utils/html");
const PasswordResetThrottle_1 = require("../models/PasswordResetThrottle");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
// Compared against when no account matches, so an unknown address costs the same time as a wrong password.
const UNKNOWN_ACCOUNT_HASH = bcrypt_1.default.hashSync(crypto_1.default.randomBytes(16).toString('hex'), 10);
// Two tabs or a retried request can present a token that was exchanged a moment ago: that is refused but is no sign of theft.
// The same token coming back later means two parties hold it, so every session of the account is ended.
const REFRESH_REUSE_GRACE_MS = 30 * 1000;
/** When a refresh token stops being accepted, read from the token itself so the record always agrees with JWT_REFRESH_EXPIRES_IN. */
const refreshExpiry = (token) => {
    const exp = jsonwebtoken_1.default.decode(token)?.exp;
    return new Date(exp ? exp * 1000 : Date.now() + 7 * 24 * 60 * 60 * 1000);
};
const throttleUpdate = (inc) => ({
    $inc: { [inc]: 1 },
    $setOnInsert: { purgeAt: new Date(Date.now() + PasswordResetThrottle_1.RESET_THROTTLE_WINDOW_MS) },
});
/** Takes one unit of an account's allowance atomically; false when it is used up. */
async function spendResetAllowance(email, field, max) {
    try {
        await PasswordResetThrottle_1.PasswordResetThrottle.findOneAndUpdate({ email, [field]: { $lt: max } }, throttleUpdate(field), { upsert: true, new: true });
        return true;
    }
    catch (e) {
        if (e?.code === 11000)
            return false; // the record exists and is at its limit, so the conditional match inserted a duplicate
        throw e;
    }
}
// ─── OTP helpers (no plaintext ever leaves this module) ───────────────────────
/** Generates a cryptographically random 6-digit string (zero-padded). */
function generateOtpPlaintext() {
    // crypto.randomInt is uniform and cryptographically secure
    const n = crypto_1.default.randomInt(0, 1_000_000);
    return n.toString().padStart(6, '0');
}
/** A short numeric code for the mobile reset flow (guarded by an attempt cap, expiry and rate limits). */
function generateResetOtp() {
    return crypto_1.default.randomInt(0, 10 ** PasswordResetOtp_1.RESET_OTP_LENGTH).toString().padStart(PasswordResetOtp_1.RESET_OTP_LENGTH, '0');
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
      <p style="color:#374151">Hello ${(0, html_1.escapeHtml)(fullName)},</p>
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
        // Self-registration only creates organizers.
        if (data.role && data.role !== User_1.Role.ORGANIZER) {
            throw { statusCode: 403, message: 'Only organizer accounts can be self-registered' };
        }
        const hashedPassword = await (0, password_1.hashPassword)(data.password);
        // Create account as active but unverified (isActive is preserved for administrative activation semantics)
        const user = await user_repository_1.userRepository.create({
            fullName: data.fullName,
            email: data.email,
            // Normalized at write time so phone-based login can do a direct
            // indexed lookup instead of scanning for every legacy raw format.
            phone: data.phone ? (0, whatsapp_service_1.normalizePhoneNumber)(data.phone) : undefined,
            passwordHash: hashedPassword,
            authProvider: User_1.AuthProvider.LOCAL,
            role: User_1.Role.ORGANIZER,
            isActive: true,
            isEmailVerified: false,
            profile: {
                invitationChannel: data.invitationChannel || 'BOTH',
                ...(data.organizationType ? { organizationType: data.organizationType } : {}),
                ...(data.organizationType === 'ORGANIZATION' && data.organizationName
                    ? { organizationName: data.organizationName }
                    : {}),
            },
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
            await user_repository_1.userRepository.deleteById(String(user._id)).catch(() => { });
            await emailVerification_repository_1.emailVerificationRepository.deleteByEmail(data.email).catch(() => { });
            console.error('[auth.service] Failed to send verification email for', data.email, ':', err instanceof Error ? err.message : 'unknown error');
            throw {
                statusCode: 503,
                exposeMessage: true,
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
        await user_repository_1.userRepository.verifyOrganizerEmail(normalised);
        // Remove OTP record
        await emailVerification_repository_1.emailVerificationRepository.deleteByEmail(normalised);
        return { verified: true };
    },
    /**
     * "Change email address" on the sign-up code page: the person typed their address wrongly in step 1, so the code went nowhere.
     * The pending (not yet verified) account moves to the corrected address and a fresh code is sent there, so step 1 does not have
     * to be filled in again, and the first address is not left behind holding the phone number and the name.
     *
     * The password chosen in step 1 proves the request comes from the person who started the sign-up; every refusal for "no such
     * pending sign-up" and "wrong password" is the same answer, so this cannot be used to find out who has an account. The new code
     * is sent before anything is changed, so a mail failure leaves the pending sign-up exactly as it was.
     */
    async changePendingEmail(data) {
        const current = data.email.trim().toLowerCase();
        const next = data.newEmail.trim().toLowerCase();
        const refused = { statusCode: 401, message: 'We could not change the email address. Check the details and try again.' };
        const user = await user_repository_1.userRepository.findByEmail(current);
        if (!user || user.role !== User_1.Role.ORGANIZER || user.isEmailVerified !== false || !(await (0, password_1.verifyPassword)(data.password, user.passwordHash ?? '')))
            throw refused;
        if (next === current)
            throw { statusCode: 400, message: 'Enter a different email address.' };
        if (await user_repository_1.userRepository.findByEmail(next)) {
            throw { statusCode: 409, message: 'This email address is already registered. Sign in, or use another address.' };
        }
        const otp = generateOtpPlaintext();
        const codeHash = await hashOtp(otp);
        try {
            await sendVerificationEmail(next, user.fullName, otp);
        }
        catch (err) {
            console.error('[auth.service] Failed to send verification email to the changed address:', err instanceof Error ? err.message : 'unknown error');
            throw { statusCode: 503, exposeMessage: true, message: 'Unable to send verification email. Please try again later.' };
        }
        try {
            await user_repository_1.userRepository.updateById(String(user._id), { email: next });
        }
        catch (err) {
            if (err?.code === 11000)
                throw { statusCode: 409, message: 'This email address is already registered. Sign in, or use another address.' };
            throw err;
        }
        await emailVerification_repository_1.emailVerificationRepository.deleteByEmail(current).catch(() => { });
        await emailVerification_repository_1.emailVerificationRepository.createOrReplace(next, codeHash);
        return { email: next };
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
        const user = await user_repository_1.userRepository.findByRoleAndEmail(normalised, User_1.Role.ORGANIZER);
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
        // Send before persisting: if SMTP fails here, the previous (still-delivered)
        // code and its cooldown stay intact instead of being replaced by a code the
        // user never received, which would otherwise leave the account with no
        // working code at all until the next successful resend.
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
        await emailVerification_repository_1.emailVerificationRepository.createOrReplace(normalised, codeHash);
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
        if (!data.email && !data.phone) {
            throw { statusCode: 400, message: 'Provide an email address or mobile number to sign in' };
        }
        const emailMatches = data.email ? await user_repository_1.userRepository.findAllByEmail(data.email.trim().toLowerCase()) : [];
        const phoneMatches = data.phone ? await user_repository_1.userRepository.findByPhone(data.phone) : [];
        const phoneIds = new Set(phoneMatches.map((candidate) => String(candidate._id)));
        const candidates = data.email && data.phone
            ? emailMatches.filter((candidate) => phoneIds.has(String(candidate._id)))
            : data.email ? emailMatches : phoneMatches;
        const passwordMatches = await Promise.all(candidates.map(async (candidate) => {
            const usable = candidate.authProvider === User_1.AuthProvider.LOCAL && !!candidate.passwordHash;
            const matches = await (0, password_1.verifyPassword)(data.password, usable ? candidate.passwordHash : UNKNOWN_ACCOUNT_HASH);
            return usable && matches ? candidate : null;
        }));
        const authenticated = passwordMatches.filter((candidate) => candidate !== null);
        const roleMatches = data.role ? authenticated.filter((candidate) => candidate.role === data.role) : authenticated;
        const user = roleMatches.length === 1 ? roleMatches[0] : authenticated.length === 1 ? authenticated[0] : null;
        if (!candidates.length)
            await (0, password_1.verifyPassword)(data.password, UNKNOWN_ACCOUNT_HASH);
        if (!user) {
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
        await token_repository_1.tokenRepository.createRefreshToken(userId, refreshToken, refreshExpiry(refreshToken));
        return { user, accessToken, refreshToken };
    },
    async refresh(token) {
        const payload = (0, token_1.verifyRefreshToken)(token);
        const consumed = await token_repository_1.tokenRepository.consumeForRotation(token);
        if (!consumed) {
            const known = await token_repository_1.tokenRepository.findByToken(token);
            if (known?.rotatedAt && Date.now() - known.rotatedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
                await token_repository_1.tokenRepository.revokeAllForUser(String(known.userId));
                (0, securityLog_1.securityEvent)('REFRESH_TOKEN_REUSED', undefined, { subject: String(known.userId) });
            }
            throw { statusCode: 401, message: 'Invalid or expired refresh token' };
        }
        const user = await user_repository_1.userRepository.findById(payload.userId);
        if (!user || !user.isActive) {
            throw { statusCode: 401, message: 'User not found or inactive' };
        }
        const userId = user._id.toString();
        const newAccessToken = (0, token_1.generateAccessToken)(userId, user.role);
        const newRefreshToken = (0, token_1.generateRefreshToken)(userId, user.role);
        await token_repository_1.tokenRepository.createRefreshToken(userId, newRefreshToken, refreshExpiry(newRefreshToken));
        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    },
    async logout(token) {
        // The body of this route is not schema-checked: anything but a string (such as a query operator) is ignored
        if (typeof token === 'string' && token) {
            await token_repository_1.tokenRepository.revokeToken(token);
        }
    },
    async forgotPassword(email) {
        const user = await user_repository_1.userRepository.findByEmail(email);
        if (!user)
            return;
        const resetToken = (0, token_1.generatePasswordResetToken)(user._id.toString(), user.role, user.passwordHash);
        const portal = user.role === User_1.Role.ADMIN ? 'admin' : user.role === User_1.Role.ORGANIZER ? 'organizer' : 'app';
        const resetUrl = `${env_1.env.FRONTEND_URL}/forgot-password?mode=${portal}&token=${encodeURIComponent(resetToken)}`;
        // Not awaited: waiting for the mail server would reveal, by the response time, that this address has an account
        void (0, email_provider_1.sendEmail)(user.email, 'Reset your LGPSM password', `<p>Hello ${(0, html_1.escapeHtml)(user.fullName)},</p><p>Use the link below to reset your password. It expires in 15 minutes.</p><p><a href="${(0, html_1.escapeHtml)(resetUrl)}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`).catch((err) => console.error('Password reset email could not be sent:', err.message));
    },
    /**
     * Mobile "Forgot password", step 1. Emails a short code when the address belongs to an active account.
     * It always returns normally, so the response never reveals whether the email is registered; repeat
     * requests inside the cooldown are ignored the same way.
     */
    async requestPasswordResetOtp(email) {
        const normalised = email.toLowerCase().trim();
        const user = await user_repository_1.userRepository.findByEmail(normalised);
        if (!user || !user.isActive)
            return;
        const existing = await PasswordResetOtp_1.PasswordResetOtp.findOne({ email: normalised });
        if (existing && Date.now() - existing.lastSentAt.getTime() < PasswordResetOtp_1.RESET_OTP_RESEND_COOLDOWN_SECONDS * 1000)
            return;
        // Bounds the mail one address can be sent, whatever IP addresses the requests come from
        if (!(await spendResetAllowance(normalised, 'codesSent', PasswordResetThrottle_1.MAX_RESET_CODES_PER_WINDOW)))
            return;
        const otp = generateResetOtp();
        const now = new Date();
        await PasswordResetOtp_1.PasswordResetOtp.findOneAndUpdate({ email: normalised }, {
            email: normalised,
            codeHash: await hashOtp(otp),
            expiresAt: new Date(now.getTime() + PasswordResetOtp_1.RESET_OTP_EXPIRY_MINUTES * 60 * 1000),
            attempts: 0,
            lastSentAt: now,
        }, { upsert: true, new: true, setDefaultsOnInsert: true });
        void (0, email_provider_1.sendEmail)(user.email, 'Your LGPSM password reset code', `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:8px">
          <h2 style="color:#111827;margin-top:0">Reset your password</h2>
          <p style="color:#374151">Hello ${(0, html_1.escapeHtml)(user.fullName)}, use this code to reset your LGPSM password. It expires in <strong>${PasswordResetOtp_1.RESET_OTP_EXPIRY_MINUTES} minutes</strong>.</p>
          <div style="text-align:center;margin:28px 0"><span style="display:inline-block;font-size:36px;font-weight:700;letter-spacing:10px;color:#FF651D;background:#fff7f0;padding:16px 24px;border-radius:8px;border:2px solid #FF651D">${otp}</span></div>
          <p style="color:#6b7280;font-size:13px">If you did not request this, you can ignore this email. Never share this code with anyone.</p>
        </div>`).catch((err) => console.error('Password reset code email could not be sent:', err.message));
    },
    /**
     * Mobile "Forgot password", step 2. Checks the emailed code and, when right, returns the same short-lived
     * single-use reset token the emailed link carries, to be used with resetPassword. Every failure gives the
     * same message so a caller cannot tell a wrong code from an expired or unknown one.
     */
    async verifyPasswordResetOtp(email, code) {
        const invalid = { statusCode: 400, message: 'Invalid or expired code.' };
        const normalised = email.toLowerCase().trim();
        // The guess is counted before it is checked, in one database step, so simultaneous requests cannot exceed the limit
        const record = await PasswordResetOtp_1.PasswordResetOtp.findOneAndUpdate({ email: normalised, expiresAt: { $gt: new Date() }, attempts: { $lt: PasswordResetOtp_1.MAX_RESET_OTP_ATTEMPTS } }, { $inc: { attempts: 1 } }, { new: true });
        if (!record)
            throw invalid;
        const throttled = await PasswordResetThrottle_1.PasswordResetThrottle.findOne({ email: normalised }).select('failedGuesses').lean();
        if ((throttled?.failedGuesses ?? 0) >= PasswordResetThrottle_1.MAX_RESET_GUESSES_PER_WINDOW)
            throw invalid;
        if (!(await verifyOtp(code, record.codeHash))) {
            (0, securityLog_1.securityEvent)('PASSWORD_RESET_OTP_FAILED', undefined, { subject: normalised });
            if (!(await spendResetAllowance(normalised, 'failedGuesses', PasswordResetThrottle_1.MAX_RESET_GUESSES_PER_WINDOW))) {
                // this account has used up its guesses for now: a further new code cannot buy more
                await PasswordResetOtp_1.PasswordResetOtp.deleteOne({ _id: record._id });
            }
            throw invalid;
        }
        // single use: a verified code is gone immediately, and whoever holds the mailbox starts afresh
        await PasswordResetOtp_1.PasswordResetOtp.deleteOne({ _id: record._id });
        await PasswordResetThrottle_1.PasswordResetThrottle.deleteOne({ email: normalised });
        const user = await user_repository_1.userRepository.findByEmail(normalised);
        if (!user || !user.isActive)
            throw invalid;
        return { resetToken: (0, token_1.generatePasswordResetToken)(user._id.toString(), user.role, user.passwordHash) };
    },
    async resetPassword(token, newPassword) {
        const payload = (0, token_1.verifyPasswordResetToken)(token);
        const user = await user_repository_1.userRepository.findById(payload.userId);
        // Invalid when the user is gone/disabled or the password changed since the link was issued (single use)
        if (!user || !user.isActive || payload.pwf !== (0, token_1.passwordFingerprint)(user.passwordHash)) {
            throw { statusCode: 400, message: 'Invalid token' };
        }
        const hashedPassword = await (0, password_1.hashPassword)(newPassword);
        await user_repository_1.userRepository.updateById(user._id.toString(), {
            passwordHash: hashedPassword,
        });
        await token_repository_1.tokenRepository.revokeAllForUser(user._id.toString());
        (0, securityLog_1.securityEvent)('PASSWORD_RESET_COMPLETED', undefined, { subject: String(user._id) });
    },
};
