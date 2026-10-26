"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewTemplateCardSchema = exports.saveVariantSchema = exports.changeGenerationSchema = exports.createGenerationSchema = exports.MOODS = exports.renderTemplateForEventSchema = exports.updateOwnTemplateSchema = exports.updateTemplateSchema = exports.createTemplateSchema = void 0;
const zod_1 = require("zod");
const mediaKey_1 = require("../utils/mediaKey");
const Template_1 = require("../models/Template");
const designSpec_1 = require("../services/cardTemplates/designSpec");
exports.createTemplateSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(100),
    categoryId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    subcategoryId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    previewImageKey: zod_1.z.string().refine(mediaKey_1.isAcceptedImageKey, 'Invalid template image reference').optional(),
    templateData: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
    // CUSTOM designs only come from the AI generation workflow, which validates and stores their specification
    cardDesign: zod_1.z.enum(Template_1.CARD_DESIGNS.filter((d) => d !== 'CUSTOM')).optional(),
    isSystemTemplate: zod_1.z.boolean().optional(),
    isPublished: zod_1.z.boolean().optional()
});
exports.updateTemplateSchema = exports.createTemplateSchema.partial();
// An organizer editing their own AI template: a name, whether it is available for their events, and (re-validated
// in full) its design. Everything that decides who owns or can see it stays out of reach.
exports.updateOwnTemplateSchema = zod_1.z
    .object({
    name: zod_1.z.string().min(2).max(100).optional(),
    isPublished: zod_1.z.boolean().optional(),
    categoryId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    subcategoryId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    designSpec: designSpec_1.designSpecSchema.optional()
})
    .strict();
exports.renderTemplateForEventSchema = zod_1.z
    .object({
    eventId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/),
    registrationUrl: zod_1.z.string().url().max(300).refine((u) => /^https:\/\//i.test(u), 'The registration link must be an https link').optional(),
    format: zod_1.z.enum(['png', 'jpeg']).optional()
})
    .strict();
exports.MOODS = ['elegant', 'modern', 'playful', 'corporate', 'festive', 'minimal', 'traditional'];
exports.createGenerationSchema = zod_1.z
    .object({
    kind: zod_1.z.enum(['INVITATION', 'POSTER']),
    preset: zod_1.z.enum(designSpec_1.CANVAS_PRESET_IDS),
    prompt: zod_1.z.string().trim().min(10, 'Describe the design in at least 10 characters').max(800, 'Keep the description under 800 characters'),
    style: zod_1.z
        .object({
        mood: zod_1.z.enum(exports.MOODS).optional(),
        colorHint: zod_1.z.string().trim().max(40).regex(/^[\p{L}\p{N} #,/&-]*$/u, 'Use plain words or hex colours').optional()
    })
        .strict()
        .optional(),
    variantCount: zod_1.z.number().int().min(1).max(3).optional(),
    idempotencyKey: zod_1.z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/).optional()
})
    .strict();
exports.changeGenerationSchema = zod_1.z
    .object({
    prompt: zod_1.z.string().trim().min(5, 'Describe what to change').max(500, 'Keep the request under 500 characters'),
    variantCount: zod_1.z.number().int().min(1).max(3).optional(),
    idempotencyKey: zod_1.z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/).optional()
})
    .strict();
exports.saveVariantSchema = zod_1.z
    .object({
    name: zod_1.z.string().trim().min(2).max(100),
    categoryId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    subcategoryId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    publish: zod_1.z.boolean().optional(),
    /** save the design over this existing template instead of creating a new one */
    replaceTemplateId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional()
})
    .strict();
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
