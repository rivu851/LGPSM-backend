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
exports.Invitee = exports.RsvpStatus = exports.InvitationStatus = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const whatsapp_service_1 = require("../services/whatsapp.service");
var InvitationStatus;
(function (InvitationStatus) {
    InvitationStatus["PENDING"] = "PENDING";
    InvitationStatus["SENT"] = "SENT";
    InvitationStatus["FAILED"] = "FAILED";
})(InvitationStatus || (exports.InvitationStatus = InvitationStatus = {}));
var RsvpStatus;
(function (RsvpStatus) {
    RsvpStatus["PENDING"] = "PENDING";
    RsvpStatus["ACCEPTED"] = "ACCEPTED";
    RsvpStatus["DECLINED"] = "DECLINED";
})(RsvpStatus || (exports.RsvpStatus = RsvpStatus = {}));
const SessionAccessSchema = new mongoose_1.Schema({
    sessionId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Session', required: true },
    allowed: { type: Boolean, required: true }
}, { _id: false });
const InviteeSchema = new mongoose_1.Schema({
    eventId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Event', required: true },
    name: { type: String, required: true, maxlength: 100 },
    email: { type: String, lowercase: true, trim: true },
    mobile: { type: String, trim: true },
    mobileKey: { type: String, select: false },
    invitationStatus: {
        type: String,
        enum: Object.values(InvitationStatus),
        default: InvitationStatus.PENDING,
        required: true
    },
    rsvpStatus: {
        type: String,
        enum: Object.values(RsvpStatus),
        default: RsvpStatus.PENDING,
        required: true
    },
    dietaryPreference: { type: String },
    dietarySelections: {
        type: [{ title: { type: String, required: true }, value: { type: String, required: true } }],
        default: undefined
    },
    companyName: { type: String, trim: true },
    professionalIdentity: { type: String, trim: true, maxlength: 100 },
    company: { type: String, trim: true },
    sessionAccess: { type: [SessionAccessSchema], default: [] },
    qrTokenHash: { type: String },
    // Encrypted copy of the current token (see utils/tokenCipher); never returned by default
    qrTokenCipher: { type: String, select: false },
    credentialRevokedAt: { type: Date, default: null },
    credentialRevocation: { type: new mongoose_1.Schema({ category: String, note: String, by: mongoose_1.Schema.Types.ObjectId, at: Date }, { _id: false }), default: null },
    credentialVersion: { type: Number },
    inviteeSetId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'InviteeSet', default: null },
    archivedAt: { type: Date, default: null },
    archivedReason: { type: String },
    supersededBySetId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'InviteeSet', default: null },
    archivedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', default: null },
    archivedByRole: { type: String, default: null },
    restoredAt: { type: Date, default: null },
    restoredBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', default: null },
    setAsideHistory: {
        type: [new mongoose_1.Schema({ archivedAt: Date, reason: String, supersededBySetId: mongoose_1.Schema.Types.ObjectId, archivedBy: mongoose_1.Schema.Types.ObjectId, archivedByRole: String, restoredAt: { type: Date, required: true }, restoredBy: { type: mongoose_1.Schema.Types.ObjectId, required: true } }, { _id: false })],
        default: undefined
    }
}, {
    timestamps: true
});
// Indexes
InviteeSchema.index({ eventId: 1 });
InviteeSchema.index({ eventId: 1, email: 1 });
InviteeSchema.index({ eventId: 1, mobile: 1 });
// The phone number in comparison form, kept in step with `mobile` whenever a guest is validated/saved.
InviteeSchema.pre('validate', function () {
    this.mobileKey = (0, whatsapp_service_1.normalizePhoneNumber)(this.mobile) || undefined;
});
// One ACTIVE guest per email and per phone number within an event. The database enforces this, so it holds across
// every backend instance. A guest is active while `archivedAt` is null; set-aside guests are outside these indexes (so
// they never block a re-upload, and restoring one is refused by the database if an active guest has taken its place).
// Guests without an email, or without a usable phone number, are outside them too. Different events are independent.
// The key order differs from the older plain (eventId, email) index on purpose, so that index can stay untouched.
InviteeSchema.index({ email: 1, eventId: 1 }, { name: 'uniq_active_event_email', unique: true, partialFilterExpression: { archivedAt: { $type: 'null' }, email: { $gt: '' } } });
InviteeSchema.index({ mobileKey: 1, eventId: 1 }, { name: 'uniq_active_event_mobile', unique: true, partialFilterExpression: { archivedAt: { $type: 'null' }, mobileKey: { $gt: '' } } });
InviteeSchema.index({ eventId: 1, rsvpStatus: 1 });
// Archived (superseded, never-invited) guests are invisible to every read. A query that must see them asks with
// `.setOptions({ includeArchived: true })`; event deletion still removes them with the rest of the event.
const READ_OPS = ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'countDocuments', 'distinct'];
for (const op of READ_OPS) {
    InviteeSchema.pre(op, function () {
        if (this.getOptions().includeArchived)
            return;
        const filter = this.getFilter();
        if (filter.archivedAt === undefined)
            this.where({ archivedAt: null });
    });
}
InviteeSchema.pre('aggregate', function () {
    if (this.options?.includeArchived)
        return;
    this.pipeline().unshift({ $match: { archivedAt: null } });
});
InviteeSchema.index({ eventId: 1, inviteeSetId: 1 });
exports.Invitee = mongoose_1.default.model('Invitee', InviteeSchema);
