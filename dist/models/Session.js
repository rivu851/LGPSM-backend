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
exports.Session = exports.InviteeSource = exports.AccessControl = void 0;
const mongoose_1 = __importStar(require("mongoose"));
var AccessControl;
(function (AccessControl) {
    AccessControl["NO_RESTRICTION"] = "NO_RESTRICTION";
    AccessControl["ONLY_ONCE"] = "ONLY_ONCE";
})(AccessControl || (exports.AccessControl = AccessControl = {}));
var InviteeSource;
(function (InviteeSource) {
    InviteeSource["NEW_LIST"] = "NEW_LIST";
    InviteeSource["COPY_SESSION"] = "COPY_SESSION";
})(InviteeSource || (exports.InviteeSource = InviteeSource = {}));
const SessionSchema = new mongoose_1.Schema({
    eventId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Event', required: true },
    name: { type: String, required: true, maxlength: 100 },
    schedule: {
        start: { type: Date, required: true },
        end: { type: Date, required: true }
    },
    admission: {
        opensAt: { type: Date, default: undefined },
        closesAt: { type: Date, default: undefined }
    },
    accessControl: {
        type: String,
        enum: Object.values(AccessControl),
        default: AccessControl.NO_RESTRICTION,
        required: true
    },
    validateAgainstOtherSessions: { type: Boolean, default: false, required: true },
    inviteeSource: {
        type: String,
        enum: Object.values(InviteeSource),
        default: InviteeSource.NEW_LIST,
        required: true
    },
    sourceSessionId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Session', default: null }
}, {
    timestamps: true
});
// Indexes
SessionSchema.index({ eventId: 1 });
SessionSchema.index({ eventId: 1, 'schedule.start': 1 });
exports.Session = mongoose_1.default.model('Session', SessionSchema);
