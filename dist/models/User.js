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
const userAuthCache_1 = require("../utils/userAuthCache");
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
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
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
// A change to any account (role, active flag, removal) must show up on the next request, not after the auth cache expires
UserSchema.post(['save', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'], () => userAuthCache_1.userAuthCache.clear());
// One organizer account per email, enforced by the database as well (two requests at once cannot both get through). Staff and admin
// accounts are outside this index: they may share an email with an organizer and with each other.
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { role: 'ORGANIZER' }, name: 'uniq_organizer_email' });
// One listing of a person per organizer's staff, enforced by the database as well: two requests at once (a double click, an admin and an
// organizer adding the same person) cannot both get through the check-then-insert in userService. The boundary is the organizer who owns
// the account (createdBy), so the same e-mail may still belong to staff of other organizers, to an organizer and to an admin; and a
// removed (inactive) account does not block adding the person again. Staff rows with no owner (not created by the app) are outside it.
UserSchema.index({ email: 1, createdBy: 1 }, { unique: true, partialFilterExpression: { role: 'SYSTEM_USER', isActive: true, createdBy: { $type: 'objectId' } }, name: 'uniq_active_staff_per_owner' });
exports.User = mongoose_1.default.model('User', UserSchema);
