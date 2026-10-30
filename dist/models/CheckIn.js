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
exports.CheckIn = exports.CheckInMethod = void 0;
const mongoose_1 = __importStar(require("mongoose"));
var CheckInMethod;
(function (CheckInMethod) {
    CheckInMethod["QR"] = "QR";
    CheckInMethod["MANUAL"] = "MANUAL";
})(CheckInMethod || (exports.CheckInMethod = CheckInMethod = {}));
const CheckInSchema = new mongoose_1.Schema({
    eventId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Event', required: true },
    inviteeId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Invitee', required: true },
    sessionId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Session', default: null },
    checkInMethod: {
        type: String,
        enum: Object.values(CheckInMethod),
        required: true
    },
    checkedInBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    checkInAt: { type: Date, default: Date.now, required: true },
    scanCount: { type: Number, default: 1 },
    lastScanAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },
    checkedOutBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', default: null }
}, {
    timestamps: true
});
// Indexes
CheckInSchema.index({ eventId: 1, checkInAt: -1 });
CheckInSchema.index({ inviteeId: 1, eventId: 1 });
CheckInSchema.index({ eventId: 1, inviteeId: 1, sessionId: 1 }, { unique: true });
CheckInSchema.index({ sessionId: 1, checkInAt: -1 });
exports.CheckIn = mongoose_1.default.model('CheckIn', CheckInSchema);
