import { z } from 'zod';
import { isAcceptedImageKey } from '../utils/mediaKey';
import { CARD_DESIGNS } from '../models/Template';
import { CANVAS_PRESET_IDS, designSpecSchema } from '../services/cardTemplates/designSpec';

export const createTemplateSchema = z.object({
  name: z.string().min(2).max(100),
  categoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  subcategoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  previewImageKey: z.string().refine(isAcceptedImageKey, 'Invalid template image reference').optional(),
  templateData: z.record(z.string(), z.any()).optional(),
  // CUSTOM designs only come from the AI generation workflow, which validates and stores their specification
  cardDesign: z.enum(CARD_DESIGNS.filter((d) => d !== 'CUSTOM') as unknown as [string, ...string[]]).optional(),
  isSystemTemplate: z.boolean().optional(),
  isPublished: z.boolean().optional()
});

export const updateTemplateSchema = createTemplateSchema.partial();

// An organizer editing their own AI template: a name, whether it is available for their events, and (re-validated
// in full) its design. Everything that decides who owns or can see it stays out of reach.
export const updateOwnTemplateSchema = z
  .object({
    name: z.string().min(2).max(100).optional(),
    isPublished: z.boolean().optional(),
    categoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    subcategoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    designSpec: designSpecSchema.optional()
  })
  .strict();

export const renderTemplateForEventSchema = z
  .object({
    eventId: z.string().regex(/^[0-9a-fA-F]{24}$/),
    registrationUrl: z.string().url().max(300).refine((u) => /^https:\/\//i.test(u), 'The registration link must be an https link').optional(),
    format: z.enum(['png', 'jpeg']).optional()
  })
  .strict();

export const MOODS = ['elegant', 'modern', 'playful', 'corporate', 'festive', 'minimal', 'traditional'] as const;

export const createGenerationSchema = z
  .object({
    kind: z.enum(['INVITATION', 'POSTER']),
    preset: z.enum(CANVAS_PRESET_IDS),
    prompt: z.string().trim().min(10, 'Describe the design in at least 10 characters').max(800, 'Keep the description under 800 characters'),
    style: z
      .object({
        mood: z.enum(MOODS).optional(),
        colorHint: z.string().trim().max(40).regex(/^[\p{L}\p{N} #,/&-]*$/u, 'Use plain words or hex colours').optional()
      })
      .strict()
      .optional(),
    variantCount: z.number().int().min(1).max(3).optional(),
    idempotencyKey: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/).optional()
  })
  .strict();

export const changeGenerationSchema = z
  .object({
    prompt: z.string().trim().min(5, 'Describe what to change').max(500, 'Keep the request under 500 characters'),
    variantCount: z.number().int().min(1).max(3).optional(),
    idempotencyKey: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/).optional()
  })
  .strict();

export const saveVariantSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    categoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    subcategoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    publish: z.boolean().optional(),
    /** save the design over this existing template instead of creating a new one */
    replaceTemplateId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional()
  })
  .strict();

// What the Add Event form has entered so far; everything is optional and short, and only uploaded media may be used
// as an image (no URL is ever fetched for a preview).
export const previewTemplateCardSchema = z
  .object({
    title: z.string().max(100).optional(),
    startIso: z.string().max(40).optional(),
    endIso: z.string().max(40).optional(),
    venue: z.string().max(300).optional(),
    locationSub: z.string().max(100).optional(),
    isVirtual: z.boolean().optional(),
    categoryName: z.string().max(100).optional(),
    subcategoryName: z.string().max(100).optional(),
    logoKey: z.string().regex(/^media:[0-9a-fA-F]{24}$/, 'Only an uploaded image can be previewed').optional(),
    guestName: z.string().max(100).optional(),
    companyName: z.string().max(100).optional()
  })
  .strict();
