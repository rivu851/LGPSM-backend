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
exports.IdempotencyKey = exports.IDEMPOTENCY_TTL_SECONDS = void 0;
const mongoose_1 = __importStar(require("mongoose"));
/**
 * Remembers a create request that carried an `Idempotency-Key`, so a repeat of the same request (a double click, a retry after a lost
 * response, a second tab) returns the first answer instead of creating the thing again. The unique index is what decides between two
 * requests that arrive together. Records remove themselves after 24 hours.
 */
exports.IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const IdempotencyKeySchema = new mongoose_1.Schema({
    userId: { type: mongoose_1.Schema.Types.ObjectId, required: true },
    scope: { type: String, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['PENDING', 'DONE'], default: 'PENDING' },
    status: { type: Number },
    body: { type: mongoose_1.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, index: { expires: exports.IDEMPOTENCY_TTL_SECONDS } },
});
IdempotencyKeySchema.index({ userId: 1, scope: 1, key: 1 }, { unique: true });
exports.IdempotencyKey = mongoose_1.default.model('IdempotencyKey', IdempotencyKeySchema);
