"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenRepository = void 0;
const crypto_1 = __importDefault(require("crypto"));
const RefreshToken_1 = require("../models/RefreshToken");
const digest = (token) => crypto_1.default.createHash('sha256').update(token).digest('hex');
// `token` holds the digest; rows from before hashing was introduced hold the token itself until they expire
const matching = (token) => ({ token: { $in: [digest(token), token] } });
exports.tokenRepository = {
    async createRefreshToken(userId, token, expiresAt) {
        const rt = new RefreshToken_1.RefreshToken({ userId, token: digest(token), expiresAt });
        return rt.save();
    },
    async findByToken(token) {
        return RefreshToken_1.RefreshToken.findOne(matching(token));
    },
    /**
     * Exchanges a token exactly once. The check and the revocation are one database step, so simultaneous requests with the
     * same token cannot both succeed. Returns null when it is unknown, expired, revoked or already exchanged.
     */
    async consumeForRotation(token) {
        const now = new Date();
        return RefreshToken_1.RefreshToken.findOneAndUpdate({ ...matching(token), isRevoked: false, expiresAt: { $gt: now } }, { $set: { isRevoked: true, rotatedAt: now } });
    },
    async revokeToken(token) {
        await RefreshToken_1.RefreshToken.updateOne(matching(token), { isRevoked: true });
    },
    async revokeAllForUser(userId) {
        await RefreshToken_1.RefreshToken.updateMany({ userId, isRevoked: false }, { isRevoked: true });
    }
};
