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
exports.InviteeSet = exports.ImportMode = void 0;
const mongoose_1 = __importStar(require("mongoose"));
var ImportMode;
(function (ImportMode) {
    ImportMode["REPLACE"] = "REPLACE";
    ImportMode["APPEND"] = "APPEND";
})(ImportMode || (exports.ImportMode = ImportMode = {}));
const InviteeSetSchema = new mongoose_1.Schema({
    eventId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    sessionId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Session', default: null },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    mode: { type: String, enum: Object.values(ImportMode), required: true },
    createdBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    createdByRole: { type: String },
    importedCount: { type: Number, default: 0 }
}, { timestamps: { createdAt: true, updatedAt: false } });
exports.InviteeSet = mongoose_1.default.model('InviteeSet', InviteeSetSchema);
