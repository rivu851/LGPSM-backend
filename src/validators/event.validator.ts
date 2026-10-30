import { isAcceptedImageKey } from '../utils/mediaKey';
import { z } from 'zod';
import { EVENT_TITLE_MAX_LENGTH, EVENT_DESCRIPTION_MAX_LENGTH } from '../constants/eventLimits';
import { CARD_INFO_FIELDS } from '../utils/cardInfo';
import { EventFormat, EventStatus } from '../models/Event';

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId format');
// "Additional Info": a ticked line names the guest detail it prints; null leaves that line empty
const cardInfoSchema = z.object({
  primary: z.enum(CARD_INFO_FIELDS).nullable(),
  secondary: z.enum(CARD_INFO_FIELDS).nullable()
}).strict();

const validateDietaryOptions = (preference: { enabled?: boolean; options?: any[] }, ctx: z.RefinementCtx) => {
  if (preference.enabled !== true) return;
  const options = preference.options || [];
  const hasValidOptions = options.length > 0 && options.every((entry) => {
    if (typeof entry === 'string') return entry.trim().length > 0;
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.options)) return false;
    return entry.options.some((option: unknown) => typeof option === 'string' && option.trim().length > 0);
  });
  if (!hasValidOptions) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Add at least one dietary option for each question.' });
  }
};

const dietaryPreferenceCreateSchema = z.object({
  enabled: z.boolean().optional(),
  title: z.string().optional(),
  options: z.array(z.any()).optional()
}).superRefine(validateDietaryOptions);

const dietaryPreferenceUpdateSchema = z.object({
  enabled: z.boolean(),
  title: z.string().optional(),
  options: z.array(z.any()).optional()
}).superRefine(validateDietaryOptions);

// When guests may be admitted (see utils/admissionWindow). null / absent = follow the event's start and end.
export const admissionSchema = z.object({
  opensAt: z.string().datetime().nullable().optional(),
  closesAt: z.string().datetime().nullable().optional()
}).strict();

export const updateAdmissionSchema = z.object({ body: admissionSchema });

// Event Location (the venue named on the invitation card) and the optional Address (extra directions) are separate fields
const locationFieldsSchema = z.object({
  address: z.string().trim().min(1, 'Event location is required').max(300, 'Event location cannot exceed 300 characters').optional(),
  addressDetails: z.string().trim().max(500, 'Address cannot exceed 500 characters').optional(),
  coordinates: z.any().optional()
}).passthrough();
const hasVenue = (loc: unknown) => (typeof loc === 'string' ? loc.trim() !== '' : !!loc && typeof loc === 'object' && typeof (loc as any).address === 'string' && (loc as any).address.trim() !== '');

export const createEventSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Title is required').max(EVENT_TITLE_MAX_LENGTH, `Title cannot exceed ${EVENT_TITLE_MAX_LENGTH} characters`),
    description: z.string().max(EVENT_DESCRIPTION_MAX_LENGTH, `Description cannot exceed ${EVENT_DESCRIPTION_MAX_LENGTH} characters`).optional().default('Event Description'),
    categoryId: objectIdSchema.optional(),
    subcategoryId: objectIdSchema.optional(),
    format: z.nativeEnum(EventFormat).optional().default(EventFormat.PHYSICAL),
    location: z.union([z.string().max(300), locationFieldsSchema]).optional(),
    contactNumber: z.string().optional(),
    schedule: z.object({
      start: z.string().optional(),
      end: z.string().optional()
    }).optional(),
    admission: admissionSchema.optional(),
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
    cardInfo: cardInfoSchema.optional(),
    dietaryPreference: dietaryPreferenceCreateSchema.optional(),
    templateId: objectIdSchema.optional(),
    media: z.object({
      // '' clears the logo
      logoKey: z.string().refine((k) => k === '' || isAcceptedImageKey(k), 'Invalid logo image reference').optional(),
      bannerKey: z.string().refine((k) => k === '' || isAcceptedImageKey(k), 'Invalid banner image reference').optional()
    }).optional()
  }).superRefine((body, ctx) => {
    if (body.format === EventFormat.PHYSICAL && !hasVenue(body.location)) {
      ctx.addIssue({ code: 'custom', path: ['location', 'address'], message: 'Event location is required' });
    }
  })
});

export const updateEventSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(EVENT_TITLE_MAX_LENGTH, `Title cannot exceed ${EVENT_TITLE_MAX_LENGTH} characters`).optional(),
    description: z.string().min(1).max(EVENT_DESCRIPTION_MAX_LENGTH, `Description cannot exceed ${EVENT_DESCRIPTION_MAX_LENGTH} characters`).optional(),
    categoryId: objectIdSchema.optional(),
    subcategoryId: objectIdSchema.optional(),
    format: z.nativeEnum(EventFormat).optional(),
    location: z.object({
      address: z.string().trim().min(1, 'Event location is required').max(300, 'Event location cannot exceed 300 characters').optional(),
      addressDetails: z.string().trim().max(500, 'Address cannot exceed 500 characters').optional(),
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
    admission: admissionSchema.optional(),
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
    cardInfo: cardInfoSchema.optional(),
    dietaryPreference: dietaryPreferenceUpdateSchema.optional(),
    templateId: objectIdSchema.optional(),
    media: z.object({
      // '' clears the logo
      logoKey: z.string().refine((k) => k === '' || isAcceptedImageKey(k), 'Invalid logo image reference').optional(),
      bannerKey: z.string().refine((k) => k === '' || isAcceptedImageKey(k), 'Invalid banner image reference').optional()
    }).optional(),
    status: z.nativeEnum(EventStatus).optional()
  })
});
