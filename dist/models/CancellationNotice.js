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
exports.CancellationNotice = exports.NOTICE_CHANNEL_STATUSES = void 0;
const mongoose_1 = __importStar(require("mongoose"));
// Durable outbox for "this event was cancelled" messages: one row per previously invited guest, one state per channel.
// It is the only record of what was sent, so the organizer can see it and retry without ever sending twice.
//
// Channel states (what actually happened, never more):
//   NOT_USED     the guest's invitation never reached them on this channel, so no notice is sent there
//   PENDING      waiting to be sent
//   SENDING      claimed by a worker; if the process dies here the outcome is unknown (see staleSending in the service)
//   SENT         the provider ACCEPTED the message. This is not delivery: neither SMTP/Brevo nor the WhatsApp API is
//                asked for, or reports, delivery confirmation in this app.
//   FAILED       attempted and refused / errored; may be retried
//   UNAVAILABLE  the provider is not configured (or the channel has no template / the guest has no address); may be
//                retried once that changes
exports.NOTICE_CHANNEL_STATUSES = ['NOT_USED', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'UNAVAILABLE'];
const ChannelSchema = new mongoose_1.Schema({
    status: { type: String, enum: exports.NOTICE_CHANNEL_STATUSES, default: 'NOT_USED' },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date },
    sentAt: { type: Date },
    failureReason: { type: String, maxlength: 300 },
    providerMessageId: { type: String }
}, { _id: false });
const CancellationNoticeSchema = new mongoose_1.Schema({
    eventId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Event', required: true },
    inviteeId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Invitee', required: true },
    organizerId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: ChannelSchema, default: () => ({}) },
    whatsapp: { type: ChannelSchema, default: () => ({}) }
}, { timestamps: true });
// One notice per guest per event: creating it twice is impossible, which is what makes enqueueing idempotent
CancellationNoticeSchema.index({ eventId: 1, inviteeId: 1 }, { unique: true });
CancellationNoticeSchema.index({ 'email.status': 1 });
CancellationNoticeSchema.index({ 'whatsapp.status': 1 });
exports.CancellationNotice = mongoose_1.default.model('CancellationNotice', CancellationNoticeSchema);
