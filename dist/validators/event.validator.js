"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateEventSchema = exports.createEventSchema = void 0;
const mediaKey_1 = require("../utils/mediaKey");
const zod_1 = require("zod");
const Event_1 = require("../models/Event");
const objectIdSchema = zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId format');
exports.createEventSchema = zod_1.z.object({
    body: zod_1.z.object({
        title: zod_1.z.string().min(1, 'Title is required').max(100, 'Title cannot exceed 100 characters'),
        description: zod_1.z.string().optional().default('Event Description'),
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
        dietaryPreference: zod_1.z.object({
            enabled: zod_1.z.boolean().optional(),
            title: zod_1.z.string().optional(),
            options: zod_1.z.array(zod_1.z.any()).optional()
        }).optional(),
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
        title: zod_1.z.string().min(1).max(100).optional(),
        description: zod_1.z.string().min(1).optional(),
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
        dietaryPreference: zod_1.z.object({
            enabled: zod_1.z.boolean(),
            title: zod_1.z.string().optional(),
            options: zod_1.z.array(zod_1.z.any()).optional()
        }).optional(),
        templateId: objectIdSchema.optional(),
        media: zod_1.z.object({
            // '' clears the logo
            logoKey: zod_1.z.string().refine((k) => k === '' || (0, mediaKey_1.isAcceptedImageKey)(k), 'Invalid logo image reference').optional(),
            bannerKey: zod_1.z.string().refine((k) => k === '' || (0, mediaKey_1.isAcceptedImageKey)(k), 'Invalid banner image reference').optional()
        }).optional(),
        status: zod_1.z.nativeEnum(Event_1.EventStatus).optional()
    })
});
