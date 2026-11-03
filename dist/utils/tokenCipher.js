"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decryptToken = exports.encryptToken = void 0;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
// Invitation tokens are looked up by SHA-256 hash. A copy is also kept encrypted (AES-256-GCM) so an
// organizer can re-download the guest's current card with a QR that still checks in. The key never
// lives in the database: QR_TOKEN_SECRET when configured, otherwise derived from JWT_SECRET.
// Copies written before QR_TOKEN_SECRET was set stay readable, so setting it never breaks links or passes already issued.
const deriveKey = (secret) => crypto_1.default.createHash('sha256').update(`lgpsm-qr-token:${secret}`).digest();
const key = () => deriveKey(process.env.QR_TOKEN_SECRET || env_1.env.JWT_SECRET);
const readKeys = () => (process.env.QR_TOKEN_SECRET ? [deriveKey(process.env.QR_TOKEN_SECRET), deriveKey(env_1.env.JWT_SECRET)] : [deriveKey(env_1.env.JWT_SECRET)]);
const encryptToken = (token) => {
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
};
exports.encryptToken = encryptToken;
const decryptToken = (payload) => {
    if (!payload)
        return null;
    for (const candidate of readKeys()) {
        try {
            const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
            const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', candidate, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
        }
        catch {
            // authentication failed under this key: try the next one
        }
    }
    return null;
};
exports.decryptToken = decryptToken;
