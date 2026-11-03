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
exports.PasswordResetThrottle = exports.MAX_RESET_CODES_PER_WINDOW = exports.MAX_RESET_GUESSES_PER_WINDOW = exports.RESET_THROTTLE_WINDOW_MS = void 0;
const mongoose_1 = __importStar(require("mongoose"));
/**
 * Per-account limits for the short emailed reset code, kept apart from the code itself because the code's own record disappears when it
 * expires or is replaced. A 4-digit code is only safe with a small total number of guesses, whatever IP addresses they come from.
 * The record removes itself 24 hours after it was started.
 */
exports.RESET_THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1000;
exports.MAX_RESET_GUESSES_PER_WINDOW = 10;
exports.MAX_RESET_CODES_PER_WINDOW = 10;
const PasswordResetThrottleSchema = new mongoose_1.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    failedGuesses: { type: Number, default: 0 },
    codesSent: { type: Number, default: 0 },
    purgeAt: { type: Date, required: true, index: { expires: 0 } },
});
exports.PasswordResetThrottle = mongoose_1.default.model('PasswordResetThrottle', PasswordResetThrottleSchema);
