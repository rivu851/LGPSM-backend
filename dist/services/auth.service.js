"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authService = void 0;
const google_auth_library_1 = require("google-auth-library");
const user_repository_1 = require("../repositories/user.repository");
const token_repository_1 = require("../repositories/token.repository");
const password_1 = require("../utils/password");
const token_1 = require("../utils/token");
const email_provider_1 = require("../utils/email.provider");
const User_1 = require("../models/User");
const alert_service_1 = require("./alert.service");
const env_1 = require("../config/env");
const googleClient = new google_auth_library_1.OAuth2Client(env_1.env.GOOGLE_CLIENT_ID);
exports.authService = {
    async register(data) {
        const existingUser = await user_repository_1.userRepository.findByEmail(data.email);
        if (existingUser) {
            throw { statusCode: 400, message: 'Email already in use' };
        }
        // Self-registration only creates organizers. Admins are provisioned out of band and
        // system users are created by an admin/organizer through the authenticated users API.
        if (data.role && data.role !== User_1.Role.ORGANIZER) {
            throw { statusCode: 403, message: 'Only organizer accounts can be self-registered' };
        }
        const assignedRole = User_1.Role.ORGANIZER;
        const hashedPassword = await (0, password_1.hashPassword)(data.password);
        const user = await user_repository_1.userRepository.create({
            fullName: data.fullName,
            email: data.email,
            phone: data.phone,
            passwordHash: hashedPassword,
            authProvider: User_1.AuthProvider.LOCAL,
            role: assignedRole
        });
        await alert_service_1.alertService.notifyAdmins('newOrganizerRegistration', {
            type: 'SYSTEM',
            title: 'New organizer registered',
            message: `${user.fullName} (${user.email}) created an organizer account.`,
            entityType: 'User',
            entityId: user._id
        });
        return user;
    },
    async login(data) {
        const user = await user_repository_1.userRepository.findByEmail(data.email);
        if (!user || !user.isActive) {
            throw { statusCode: 401, message: 'Invalid credentials or inactive account' };
        }
        if (user.authProvider !== User_1.AuthProvider.LOCAL || !user.passwordHash) {
            throw { statusCode: 401, message: 'Invalid authentication method' };
        }
        const isMatch = await (0, password_1.verifyPassword)(data.password, user.passwordHash);
        if (!isMatch) {
            throw { statusCode: 401, message: 'Invalid credentials or inactive account' };
        }
        // The login portal (Admin / Organizer / System User) must match the stored role.
        // A login request can never change a user's role.
        if (data.role && data.role !== user.role) {
            throw { statusCode: 403, message: `This account is not registered as ${String(data.role).replace('_', ' ').toLowerCase()}. Please use the correct login option.` };
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
            user = await user_repository_1.userRepository.create({
                fullName: payload.name || 'Google User',
                email: payload.email,
                authProvider: User_1.AuthProvider.GOOGLE,
                role: User_1.Role.ORGANIZER
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
        // The portal mode lets the reset page send the user back to the right login screen
        const portal = user.role === User_1.Role.ADMIN ? 'admin' : user.role === User_1.Role.ORGANIZER ? 'organizer' : 'app';
        const resetUrl = `${env_1.env.FRONTEND_URL}/forgot-password?mode=${portal}&token=${encodeURIComponent(resetToken)}`;
        try {
            await (0, email_provider_1.sendEmail)(user.email, 'Reset your LGPSM password', `<p>Hello ${user.fullName},</p><p>Use the link below to reset your password. It expires in 15 minutes.</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`);
        }
        catch (err) {
            // Without a working mail provider the link is only surfaced to developers
            if (env_1.env.NODE_ENV !== 'production') {
                console.log(`[DEV ONLY] Password reset link for ${email}: ${resetUrl}`);
            }
            else {
                console.error('Password reset email could not be sent:', err.message);
            }
        }
    },
    async resetPassword(token, newPassword) {
        const payload = (0, token_1.verifyPasswordResetToken)(token);
        const user = await user_repository_1.userRepository.findById(payload.userId);
        if (!user) {
            throw { statusCode: 400, message: 'Invalid token' };
        }
        const hashedPassword = await (0, password_1.hashPassword)(newPassword);
        await user_repository_1.userRepository.updateById(user._id.toString(), { passwordHash: hashedPassword });
        await token_repository_1.tokenRepository.revokeAllForUser(user._id.toString());
    }
};
