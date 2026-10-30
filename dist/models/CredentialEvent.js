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
exports.CredentialEvent = exports.CREDENTIAL_EVENT_TYPES = void 0;
const mongoose_1 = __importStar(require("mongoose"));
// Append-only history of a guest's access passes. Rows are never edited or removed (the revocation of a pass stays on record
// with its reason even after the pass is replaced). The raw token is never stored; `tokenHash` is the same one-way hash the
// guest record already holds, kept so a superseded link can be recognised and explained.
exports.CREDENTIAL_EVENT_TYPES = ['ISSUED', 'REPLACED', 'REVOKED'];
const CredentialEventSchema = new mongoose_1.Schema({
    eventId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Event', required: true },
    inviteeId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Invitee', required: true },
    organizerId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: exports.CREDENTIAL_EVENT_TYPES, required: true },
    version: { type: Number, required: true },
    previousVersion: { type: Number },
    source: { type: String, enum: ['SEND', 'RESEND', 'REPLACE', 'REVOKE'], required: true },
    reasonCategory: { type: String },
    note: { type: String, maxlength: 500 },
    actorId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    reviewConfirmed: { type: Boolean },
    tokenHash: { type: String, select: false }
}, { timestamps: { createdAt: true, updatedAt: false } });
CredentialEventSchema.index({ eventId: 1, createdAt: -1 });
CredentialEventSchema.index({ inviteeId: 1, createdAt: 1 });
CredentialEventSchema.index({ tokenHash: 1 }, { sparse: true });
exports.CredentialEvent = mongoose_1.default.model('CredentialEvent', CredentialEventSchema);
