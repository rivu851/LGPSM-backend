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
exports.Invitation = exports.InvitationDeliveryStatus = exports.DeliveryChannel = void 0;
const mongoose_1 = __importStar(require("mongoose"));
var DeliveryChannel;
(function (DeliveryChannel) {
    DeliveryChannel["EMAIL"] = "EMAIL";
    DeliveryChannel["SMS"] = "SMS";
    DeliveryChannel["WHATSAPP"] = "WHATSAPP";
    DeliveryChannel["BOTH"] = "BOTH";
})(DeliveryChannel || (exports.DeliveryChannel = DeliveryChannel = {}));
var InvitationDeliveryStatus;
(function (InvitationDeliveryStatus) {
    InvitationDeliveryStatus["PENDING"] = "PENDING";
    InvitationDeliveryStatus["SENT"] = "SENT";
    InvitationDeliveryStatus["FAILED"] = "FAILED";
})(InvitationDeliveryStatus || (exports.InvitationDeliveryStatus = InvitationDeliveryStatus = {}));
const InvitationSchema = new mongoose_1.Schema({
    eventId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Event', required: true },
    inviteeId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Invitee', required: true },
    channel: {
        type: String,
        enum: Object.values(DeliveryChannel),
        required: true
    },
    status: {
        type: String,
        enum: Object.values(InvitationDeliveryStatus),
        default: InvitationDeliveryStatus.PENDING,
        required: true
    },
    sentAt: { type: Date },
    failureReason: { type: String },
    tokenHash: { type: String, required: true },
    emailStatus: { type: String, enum: Object.values(InvitationDeliveryStatus) },
    emailFailureReason: { type: String },
    whatsappStatus: { type: String, enum: Object.values(InvitationDeliveryStatus) },
    whatsappMessageId: { type: String },
    whatsappFailureReason: { type: String },
    clearedAt: { type: Date }
}, {
    timestamps: true
});
// Indexes for fast querying and status tracking
InvitationSchema.index({ eventId: 1 });
InvitationSchema.index({ inviteeId: 1 });
InvitationSchema.index({ eventId: 1, inviteeId: 1 });
InvitationSchema.index({ status: 1 });
InvitationSchema.index({ tokenHash: 1 });
exports.Invitation = mongoose_1.default.model('Invitation', InvitationSchema);
