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
exports.PassNotice = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const CancellationNotice_1 = require("./CancellationNotice");
const ChannelSchema = new mongoose_1.Schema({
    status: { type: String, enum: CancellationNotice_1.NOTICE_CHANNEL_STATUSES, default: 'NOT_USED' },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date },
    sentAt: { type: Date },
    failureReason: { type: String, maxlength: 300 },
    providerMessageId: { type: String }
}, { _id: false });
const PassNoticeSchema = new mongoose_1.Schema({
    eventId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Event', required: true },
    inviteeId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Invitee', required: true },
    organizerId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    credentialEventId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'CredentialEvent', required: true },
    kind: { type: String, enum: ['REPLACED', 'REVOKED'], required: true },
    credentialVersion: { type: Number, required: true },
    email: { type: ChannelSchema, default: () => ({}) },
    whatsapp: { type: ChannelSchema, default: () => ({}) }
}, { timestamps: true });
// one notice per credential change: creating it twice is impossible, which makes enqueueing idempotent
PassNoticeSchema.index({ credentialEventId: 1 }, { unique: true });
PassNoticeSchema.index({ eventId: 1, createdAt: -1 });
exports.PassNotice = mongoose_1.default.model('PassNotice', PassNoticeSchema);
