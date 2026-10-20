import { z } from 'zod';
import { isAcceptedImageKey } from '../utils/mediaKey';
import { CARD_DESIGNS } from '../models/Template';

export const createTemplateSchema = z.object({
  name: z.string().min(2).max(100),
  categoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  subcategoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  previewImageKey: z.string().refine(isAcceptedImageKey, 'Invalid template image reference').optional(),
  templateData: z.record(z.string(), z.any()).optional(),
  cardDesign: z.enum(CARD_DESIGNS).optional(),
  isSystemTemplate: z.boolean().optional(),
  isPublished: z.boolean().optional()
});

export const updateTemplateSchema = createTemplateSchema.partial();

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
