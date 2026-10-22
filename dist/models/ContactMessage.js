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
exports.ContactMessage = exports.ContactMessageStatus = void 0;
const mongoose_1 = __importStar(require("mongoose"));
var ContactMessageStatus;
(function (ContactMessageStatus) {
    ContactMessageStatus["NEW"] = "NEW";
    ContactMessageStatus["IN_PROGRESS"] = "IN_PROGRESS";
    ContactMessageStatus["RESOLVED"] = "RESOLVED";
})(ContactMessageStatus || (exports.ContactMessageStatus = ContactMessageStatus = {}));
const ContactMessageSchema = new mongoose_1.Schema({
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 20 },
    message: { type: String, required: true, maxlength: 2000 },
    status: { type: String, enum: Object.values(ContactMessageStatus), default: ContactMessageStatus.NEW },
    fingerprint: { type: String, required: true },
    dedupeKey: { type: String, required: true, unique: true },
    ipHash: { type: String },
    userAgent: { type: String, maxlength: 200 }
}, { timestamps: true });
ContactMessageSchema.index({ status: 1, createdAt: -1 });
ContactMessageSchema.index({ fingerprint: 1, createdAt: -1 });
exports.ContactMessage = mongoose_1.default.model('ContactMessage', ContactMessageSchema);
