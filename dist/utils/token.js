"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAccessToken = generateAccessToken;
exports.generateRefreshToken = generateRefreshToken;
exports.verifyAccessToken = verifyAccessToken;
exports.verifyRefreshToken = verifyRefreshToken;
exports.passwordFingerprint = passwordFingerprint;
exports.generatePasswordResetToken = generatePasswordResetToken;
exports.verifyPasswordResetToken = verifyPasswordResetToken;
const crypto_1 = __importDefault(require("crypto"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
function generateAccessToken(userId, role) {
    const payload = { userId, role, type: 'access' };
    return jsonwebtoken_1.default.sign(payload, env_1.env.JWT_SECRET, { expiresIn: env_1.env.JWT_EXPIRES_IN });
}
function generateRefreshToken(userId, role) {
    const payload = { userId, role, type: 'refresh', nonce: crypto_1.default.randomBytes(12).toString('hex') };
    return jsonwebtoken_1.default.sign(payload, env_1.env.JWT_REFRESH_SECRET, { expiresIn: env_1.env.JWT_REFRESH_EXPIRES_IN });
}
function verifyAccessToken(token) {
    const decoded = jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.type !== 'access') {
        throw new Error('Invalid token type');
    }
    return decoded;
}
function verifyRefreshToken(token) {
    const decoded = jsonwebtoken_1.default.verify(token, env_1.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    if (decoded.type !== 'refresh') {
        throw new Error('Invalid token type');
    }
    return decoded;
}
// Single-purpose password reset token; it cannot be used as an API access token
function passwordFingerprint(passwordHash) {
    return crypto_1.default.createHash('sha256').update(passwordHash ?? '').digest('hex').slice(0, 16);
}
// The token carries a fingerprint of the current password hash, so it stops working as soon as the
// password changes: a reset link can be used once, and an old link dies after any other password change.
function generatePasswordResetToken(userId, role, passwordHash) {
    const payload = { userId, role, type: 'reset', pwf: passwordFingerprint(passwordHash) };
    return jsonwebtoken_1.default.sign(payload, env_1.env.JWT_SECRET, { expiresIn: '15m' });
}
function verifyPasswordResetToken(token) {
    const decoded = jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.type !== 'reset') {
        throw new Error('Invalid token type');
    }
    return decoded;
}
