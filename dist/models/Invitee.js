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
    companyName: { type: String, trim: true },
    company: { type: String, trim: true },
    sessionAccess: { type: [SessionAccessSchema], default: [] },
    qrTokenHash: { type: String },
    // Encrypted copy of the current token (see utils/tokenCipher); never returned by default
    qrTokenCipher: { type: String, select: false }
}, {
    timestamps: true
});
// Indexes
InviteeSchema.index({ eventId: 1 });
InviteeSchema.index({ eventId: 1, email: 1 });
InviteeSchema.index({ eventId: 1, mobile: 1 });
InviteeSchema.index({ eventId: 1, rsvpStatus: 1 });
exports.Invitee = mongoose_1.default.model('Invitee', InviteeSchema);
