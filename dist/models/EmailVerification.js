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
exports.EmailVerification = exports.RESEND_COOLDOWN_SECONDS = exports.MAX_OTP_ATTEMPTS = exports.OTP_EXPIRY_MINUTES = void 0;
const mongoose_1 = __importStar(require("mongoose"));
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
exports.OTP_EXPIRY_MINUTES = 10;
exports.MAX_OTP_ATTEMPTS = 5;
exports.RESEND_COOLDOWN_SECONDS = 60;
const EmailVerificationSchema = new mongoose_1.Schema({
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
}, {
    timestamps: true,
    toJSON: {
        transform: (_doc, ret) => {
            // Never expose the hash through serialisation
            delete ret.codeHash;
            delete ret.__v;
            return ret;
        },
    },
});
exports.EmailVerification = mongoose_1.default.model('EmailVerification', EmailVerificationSchema);
