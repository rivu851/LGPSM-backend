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
exports.TemplateGenerationJob = exports.JOB_MODES = exports.JOB_STATUSES = void 0;
const mongoose_1 = __importStar(require("mongoose"));
// One AI template-generation request and its outcome. Persisted so a request survives a page reload or a restart,
// can be polled by web and mobile, and can never stay "running" forever (see leaseExpiresAt and the recovery in
// templateGeneration.service.ts). Jobs delete themselves after a week (TTL on expiresAt).
exports.JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'CONCEPT_ONLY', 'FAILED'];
exports.JOB_MODES = ['CREATE', 'EDIT', 'VARIATIONS'];
const VariantSchema = new mongoose_1.Schema({
    index: { type: Number, required: true },
    projectId: { type: String, required: true },
    screenId: { type: String, required: true },
    conceptImageKey: String,
    previewImageKey: String,
    ready: { type: Boolean, required: true },
    fidelity: { type: String, enum: ['STYLE_ADAPTED', 'NONE'], default: 'NONE' },
    notes: [String],
    designSpec: mongoose_1.Schema.Types.Mixed,
    templateId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Template' }
}, { _id: false });
const JobSchema = new mongoose_1.Schema({
    ownerId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['INVITATION', 'POSTER'], required: true },
    preset: { type: String, required: true },
    mode: { type: String, enum: exports.JOB_MODES, default: 'CREATE' },
    prompt: { type: String, required: true, maxlength: 1200 },
    promptHash: { type: String, required: true },
    style: { mood: String, colorHint: String },
    variantCount: { type: Number, default: 1, min: 1, max: 3 },
    parentJobId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'TemplateGenerationJob' },
    parentVariantIndex: Number,
    parentTemplateId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Template' },
    status: { type: String, enum: exports.JOB_STATUSES, default: 'QUEUED', index: true },
    error: { type: new mongoose_1.Schema({ code: String, message: String }, { _id: false }) },
    variants: { type: [VariantSchema], default: [] },
    idempotencyKey: { type: String, maxlength: 80 },
    startedAt: Date,
    finishedAt: Date,
    leaseExpiresAt: Date,
    expiresAt: { type: Date, required: true }
}, { timestamps: true });
JobSchema.index({ ownerId: 1, createdAt: -1 });
JobSchema.index({ ownerId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
JobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
exports.TemplateGenerationJob = mongoose_1.default.model('TemplateGenerationJob', JobSchema);
