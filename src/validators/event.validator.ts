import { isAcceptedImageKey } from '../utils/mediaKey';
import { z } from 'zod';
import { EventFormat, EventStatus } from '../models/Event';

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId format');

export const createEventSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Title is required').max(100, 'Title cannot exceed 100 characters'),
    description: z.string().optional().default('Event Description'),
    categoryId: objectIdSchema.optional(),
    subcategoryId: objectIdSchema.optional(),
    format: z.nativeEnum(EventFormat).optional().default(EventFormat.PHYSICAL),
    location: z.any().optional(),
    contactNumber: z.string().optional(),
    schedule: z.object({
      start: z.string().optional(),
      end: z.string().optional()
    }).optional(),
    rsvp: z.object({
      enabled: z.boolean().optional(),
      acceptanceLastDate: z.string().optional(),
      allowAllInvited: z.boolean().optional(),
      allowNotResponded: z.boolean().optional(),
      allowDeclined: z.boolean().optional()
    }).optional(),
    attendeeSettings: z.object({
      thresholdLimit: z.number().positive().optional()
    }).optional(),
    dietaryPreference: z.object({
      enabled: z.boolean().optional(),
      title: z.string().optional(),
      options: z.array(z.any()).optional()
    }).optional(),
    templateId: objectIdSchema.optional(),
    media: z.object({
      // '' clears the logo
      logoKey: z.string().refine((k) => k === '' || isAcceptedImageKey(k), 'Invalid logo image reference').optional(),
      bannerKey: z.string().refine((k) => k === '' || isAcceptedImageKey(k), 'Invalid banner image reference').optional()
    }).optional()
  })
});

export const updateEventSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(100).optional(),
    description: z.string().min(1).optional(),
    categoryId: objectIdSchema.optional(),
    subcategoryId: objectIdSchema.optional(),
    format: z.nativeEnum(EventFormat).optional(),
    location: z.object({
      address: z.string().optional(),
      coordinates: z.tuple([
        z.number().min(-180).max(180),
        z.number().min(-90).max(90)
      ]).optional()
    }).optional(),
    contactNumber: z.string().optional(),
    schedule: z.object({
      start: z.string().datetime(),
      end: z.string().datetime()
    }).refine(data => new Date(data.start) < new Date(data.end), {
      message: "End time must be after start time",
      path: ["end"]
    }).optional(),
    rsvp: z.object({
      enabled: z.boolean(),
      acceptanceLastDate: z.string().datetime().optional(),
      allowAllInvited: z.boolean(),
      allowNotResponded: z.boolean(),
      allowDeclined: z.boolean()
    }).optional(),
    attendeeSettings: z.object({
      thresholdLimit: z.number().positive().optional()
    }).optional(),
    dietaryPreference: z.object({
      enabled: z.boolean(),
      title: z.string().optional(),
      options: z.array(z.any()).optional()
    }).optional(),
    templateId: objectIdSchema.optional(),
    media: z.object({
      // '' clears the logo
      logoKey: z.string().refine((k) => k === '' || isAcceptedImageKey(k), 'Invalid logo image reference').optional(),
      bannerKey: z.string().refine((k) => k === '' || isAcceptedImageKey(k), 'Invalid banner image reference').optional()
    }).optional(),
    status: z.nativeEnum(EventStatus).optional()
  })
});
