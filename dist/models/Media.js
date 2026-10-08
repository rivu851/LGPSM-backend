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
exports.Media = exports.MediaPurpose = void 0;
const mongoose_1 = __importStar(require("mongoose"));
// Images stored in the database so uploads persist on any deployment without external object storage.
// Referenced from other documents as `media:<id>` (see utils/mediaKey.ts).
var MediaPurpose;
(function (MediaPurpose) {
    MediaPurpose["TEMPLATE"] = "TEMPLATE";
    MediaPurpose["EVENT_LOGO"] = "EVENT_LOGO";
    MediaPurpose["ORGANIZATION_LOGO"] = "ORGANIZATION_LOGO";
    MediaPurpose["AVATAR"] = "AVATAR";
})(MediaPurpose || (exports.MediaPurpose = MediaPurpose = {}));
const MediaSchema = new mongoose_1.Schema({
    ownerId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: Object.values(MediaPurpose), required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    width: { type: Number },
    height: { type: Number },
    originalName: { type: String },
    data: { type: Buffer, required: true, select: false }
}, { timestamps: true });
MediaSchema.index({ ownerId: 1, purpose: 1 });
exports.Media = mongoose_1.default.model('Media', MediaSchema);
