import { z } from 'zod';
import { isAcceptedImageKey } from '../utils/mediaKey';

export const createTemplateSchema = z.object({
  name: z.string().min(2).max(100),
  categoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  subcategoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  previewImageKey: z.string().refine(isAcceptedImageKey, 'Invalid template image reference').optional(),
  templateData: z.record(z.string(), z.any()).optional(),
  isSystemTemplate: z.boolean().optional(),
  isPublished: z.boolean().optional()
});

export const updateTemplateSchema = createTemplateSchema.partial();
