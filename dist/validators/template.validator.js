"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewTemplateCardSchema = exports.updateTemplateSchema = exports.createTemplateSchema = void 0;
const zod_1 = require("zod");
const mediaKey_1 = require("../utils/mediaKey");
const Template_1 = require("../models/Template");
exports.createTemplateSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(100),
    categoryId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    subcategoryId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    previewImageKey: zod_1.z.string().refine(mediaKey_1.isAcceptedImageKey, 'Invalid template image reference').optional(),
    templateData: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
    cardDesign: zod_1.z.enum(Template_1.CARD_DESIGNS).optional(),
    isSystemTemplate: zod_1.z.boolean().optional(),
    isPublished: zod_1.z.boolean().optional()
});
exports.updateTemplateSchema = exports.createTemplateSchema.partial();
// What the Add Event form has entered so far; everything is optional and short, and only uploaded media may be used
// as an image (no URL is ever fetched for a preview).
exports.previewTemplateCardSchema = zod_1.z
    .object({
    title: zod_1.z.string().max(100).optional(),
    startIso: zod_1.z.string().max(40).optional(),
    endIso: zod_1.z.string().max(40).optional(),
    venue: zod_1.z.string().max(300).optional(),
    locationSub: zod_1.z.string().max(100).optional(),
    isVirtual: zod_1.z.boolean().optional(),
    categoryName: zod_1.z.string().max(100).optional(),
    subcategoryName: zod_1.z.string().max(100).optional(),
    logoKey: zod_1.z.string().regex(/^media:[0-9a-fA-F]{24}$/, 'Only an uploaded image can be previewed').optional(),
    guestName: zod_1.z.string().max(100).optional(),
    companyName: zod_1.z.string().max(100).optional()
})
    .strict();
