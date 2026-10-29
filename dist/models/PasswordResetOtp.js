"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PasswordResetOtp = exports.RESET_OTP_RESEND_COOLDOWN_SECONDS = exports.MAX_RESET_OTP_ATTEMPTS = exports.RESET_OTP_EXPIRY_MINUTES = exports.RESET_OTP_LENGTH = void 0;
const mongoose_1 = __importStar(require("mongoose"));
/**
 * A pending password-reset code (mobile "Forgot password" flow).
 *
 *  - `codeHash` is bcrypt(code); the plaintext is only ever emailed, never stored.
 *  - `expiresAt` is enforced by the TTL index and again in code.
 *  - `attempts` counts wrong guesses; the code is dead after MAX_RESET_OTP_ATTEMPTS and a fresh one must be requested.
 *  - `lastSentAt` backs the resend cooldown.
 * One document per email: requesting a new code replaces the previous one.
 */
exports.RESET_OTP_LENGTH = 4;
exports.RESET_OTP_EXPIRY_MINUTES = 10;
exports.MAX_RESET_OTP_ATTEMPTS = 5;
exports.RESET_OTP_RESEND_COOLDOWN_SECONDS = 30;
const PasswordResetOtpSchema = new mongoose_1.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
}, { timestamps: true });
exports.PasswordResetOtp = mongoose_1.default.model('PasswordResetOtp', PasswordResetOtpSchema);
