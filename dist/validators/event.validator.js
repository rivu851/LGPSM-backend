"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateEventSchema = exports.createEventSchema = void 0;
const mediaKey_1 = require("../utils/mediaKey");
const zod_1 = require("zod");
const eventLimits_1 = require("../constants/eventLimits");
const cardInfo_1 = require("../utils/cardInfo");
const Event_1 = require("../models/Event");
const objectIdSchema = zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId format');
// "Additional Info": a ticked line names the guest detail it prints; null leaves that line empty
const cardInfoSchema = zod_1.z.object({
    primary: zod_1.z.enum(cardInfo_1.CARD_INFO_FIELDS).nullable(),
    secondary: zod_1.z.enum(cardInfo_1.CARD_INFO_FIELDS).nullable()
}).strict();
const validateDietaryOptions = (preference, ctx) => {
    if (preference.enabled !== true)
        return;
    const options = preference.options || [];
    const hasValidOptions = options.length > 0 && options.every((entry) => {
        if (typeof entry === 'string')
            return entry.trim().length > 0;
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.options))
            return false;
        return entry.options.some((option) => typeof option === 'string' && option.trim().length > 0);
    });
    if (!hasValidOptions) {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, path: ['options'], message: 'Add at least one dietary option for each question.' });
    }
};
const dietaryPreferenceCreateSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().optional(),
    title: zod_1.z.string().optional(),
    options: zod_1.z.array(zod_1.z.any()).optional()
}).superRefine(validateDietaryOptions);
const dietaryPreferenceUpdateSchema = zod_1.z.object({
    enabled: zod_1.z.boolean(),
    title: zod_1.z.string().optional(),
    options: zod_1.z.array(zod_1.z.any()).optional()
}).superRefine(validateDietaryOptions);
exports.createEventSchema = zod_1.z.object({
    body: zod_1.z.object({
        title: zod_1.z.string().min(1, 'Title is required').max(eventLimits_1.EVENT_TITLE_MAX_LENGTH, `Title cannot exceed ${eventLimits_1.EVENT_TITLE_MAX_LENGTH} characters`),
        description: zod_1.z.string().max(eventLimits_1.EVENT_DESCRIPTION_MAX_LENGTH, `Description cannot exceed ${eventLimits_1.EVENT_DESCRIPTION_MAX_LENGTH} characters`).optional().default('Event Description'),
        categoryId: objectIdSchema.optional(),
        subcategoryId: objectIdSchema.optional(),
        format: zod_1.z.nativeEnum(Event_1.EventFormat).optional().default(Event_1.EventFormat.PHYSICAL),
        location: zod_1.z.any().optional(),
        contactNumber: zod_1.z.string().optional(),
        schedule: zod_1.z.object({
            start: zod_1.z.string().optional(),
            end: zod_1.z.string().optional()
        }).optional(),
        rsvp: zod_1.z.object({
            enabled: zod_1.z.boolean().optional(),
            acceptanceLastDate: zod_1.z.string().optional(),
            allowAllInvited: zod_1.z.boolean().optional(),
            allowNotResponded: zod_1.z.boolean().optional(),
            allowDeclined: zod_1.z.boolean().optional()
        }).optional(),
        attendeeSettings: zod_1.z.object({
            thresholdLimit: zod_1.z.number().positive().optional()
        }).optional(),
        cardInfo: cardInfoSchema.optional(),
        dietaryPreference: dietaryPreferenceCreateSchema.optional(),
        templateId: objectIdSchema.optional(),
        media: zod_1.z.object({
            // '' clears the logo
            logoKey: zod_1.z.string().refine((k) => k === '' || (0, mediaKey_1.isAcceptedImageKey)(k), 'Invalid logo image reference').optional(),
            bannerKey: zod_1.z.string().refine((k) => k === '' || (0, mediaKey_1.isAcceptedImageKey)(k), 'Invalid banner image reference').optional()
        }).optional()
    })
});
exports.updateEventSchema = zod_1.z.object({
    body: zod_1.z.object({
        title: zod_1.z.string().min(1).max(eventLimits_1.EVENT_TITLE_MAX_LENGTH, `Title cannot exceed ${eventLimits_1.EVENT_TITLE_MAX_LENGTH} characters`).optional(),
        description: zod_1.z.string().min(1).max(eventLimits_1.EVENT_DESCRIPTION_MAX_LENGTH, `Description cannot exceed ${eventLimits_1.EVENT_DESCRIPTION_MAX_LENGTH} characters`).optional(),
        categoryId: objectIdSchema.optional(),
        subcategoryId: objectIdSchema.optional(),
        format: zod_1.z.nativeEnum(Event_1.EventFormat).optional(),
        location: zod_1.z.object({
            address: zod_1.z.string().optional(),
            coordinates: zod_1.z.tuple([
                zod_1.z.number().min(-180).max(180),
                zod_1.z.number().min(-90).max(90)
            ]).optional()
        }).optional(),
        contactNumber: zod_1.z.string().optional(),
        schedule: zod_1.z.object({
            start: zod_1.z.string().datetime(),
            end: zod_1.z.string().datetime()
        }).refine(data => new Date(data.start) < new Date(data.end), {
            message: "End time must be after start time",
            path: ["end"]
        }).optional(),
        rsvp: zod_1.z.object({
            enabled: zod_1.z.boolean(),
            acceptanceLastDate: zod_1.z.string().datetime().optional(),
            allowAllInvited: zod_1.z.boolean(),
            allowNotResponded: zod_1.z.boolean(),
            allowDeclined: zod_1.z.boolean()
        }).optional(),
        attendeeSettings: zod_1.z.object({
            thresholdLimit: zod_1.z.number().positive().optional()
        }).optional(),
        cardInfo: cardInfoSchema.optional(),
        dietaryPreference: dietaryPreferenceUpdateSchema.optional(),
        templateId: objectIdSchema.optional(),
        media: zod_1.z.object({
            // '' clears the logo
            logoKey: zod_1.z.string().refine((k) => k === '' || (0, mediaKey_1.isAcceptedImageKey)(k), 'Invalid logo image reference').optional(),
            bannerKey: zod_1.z.string().refine((k) => k === '' || (0, mediaKey_1.isAcceptedImageKey)(k), 'Invalid banner image reference').optional()
        }).optional(),
        status: zod_1.z.nativeEnum(Event_1.EventStatus).optional()
    })
});
