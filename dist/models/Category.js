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
exports.Category = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const SubcategorySchema = new mongoose_1.Schema({
    name: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    ownerId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
const CategorySchema = new mongoose_1.Schema({
    name: { type: String, required: true },
    description: { type: String },
    subcategories: { type: [SubcategorySchema], default: [] },
    isActive: { type: Boolean, default: true },
    ownerId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' }
}, {
    timestamps: true
});
// Names are unique per owner. The platform's own categories have no owner, so they share the "no owner" slot and stay unique
// among themselves, and each organizer's custom ones are unique among that organizer's.
// (Databases from before custom categories hold a plain unique index on name: scripts/migrate-category-uniqueness.js replaces it.)
CategorySchema.index({ ownerId: 1, name: 1 }, { unique: true, name: 'owner_scoped_name_unique' });
exports.Category = mongoose_1.default.model('Category', CategorySchema);
