"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addSubcategorySchema = exports.updateCategorySchema = exports.createCategorySchema = void 0;
const zod_1 = require("zod");
exports.createCategorySchema = zod_1.z.object({
    name: zod_1.z.string().min(2, 'Name must be at least 2 characters').max(100),
    description: zod_1.z.string().optional(),
    subcategories: zod_1.z.array(zod_1.z.object({
        name: zod_1.z.string().min(1),
        isActive: zod_1.z.boolean().optional()
    })).optional(),
    isActive: zod_1.z.boolean().optional()
});
exports.updateCategorySchema = exports.createCategorySchema.extend({
    // Existing subcategories must be sent with their _id so their identity is preserved
    subcategories: zod_1.z.array(zod_1.z.object({
        _id: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
        name: zod_1.z.string().min(1),
        isActive: zod_1.z.boolean().optional()
    })).optional()
}).partial();
exports.addSubcategorySchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(1, 'Subcategory name is required').max(100)
});
