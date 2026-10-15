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
exports.User = exports.AuthProvider = exports.Role = void 0;
const mongoose_1 = __importStar(require("mongoose"));
var Role;
(function (Role) {
    Role["ADMIN"] = "ADMIN";
    Role["ORGANIZER"] = "ORGANIZER";
    Role["SYSTEM_USER"] = "SYSTEM_USER";
})(Role || (exports.Role = Role = {}));
var AuthProvider;
(function (AuthProvider) {
    AuthProvider["LOCAL"] = "LOCAL";
    AuthProvider["GOOGLE"] = "GOOGLE";
})(AuthProvider || (exports.AuthProvider = AuthProvider = {}));
const UserSchema = new mongoose_1.Schema({
    // Indexed (non-unique) so admin/organizer user search can sort/filter by
    // name without a full collection scan.
    fullName: { type: String, required: true, index: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Stored in normalized form (see whatsapp.service.ts normalizePhoneNumber) so
    // phone-based login can do a direct indexed lookup instead of scanning the
    // collection. Not unique: existing data may still contain duplicates/legacy
    // raw formats — see src/scripts/normalizePhoneNumbers.ts for backfilling.
    phone: { type: String, index: true },
    passwordHash: { type: String },
    authProvider: { type: String, enum: Object.values(AuthProvider), default: AuthProvider.LOCAL },
    role: { type: String, enum: Object.values(Role), default: Role.ORGANIZER },
    profile: { type: mongoose_1.Schema.Types.Mixed },
    // Who created this account (admins/organizers create staff); scopes which organizer sees it
    createdBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: true },
}, {
    timestamps: true,
    toJSON: {
        transform: function (doc, ret) {
            delete ret.passwordHash;
            delete ret.__v;
            return ret;
        }
    }
});
exports.User = mongoose_1.default.model('User', UserSchema);
