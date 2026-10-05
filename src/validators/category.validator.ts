import { z } from 'zod';

export const createCategorySchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  description: z.string().optional(),
  subcategories: z.array(z.object({
    name: z.string().min(1),
    isActive: z.boolean().optional()
  })).optional(),
  isActive: z.boolean().optional()
});

export const updateCategorySchema = createCategorySchema.extend({
  // Existing subcategories must be sent with their _id so their identity is preserved
  subcategories: z.array(z.object({
    _id: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    name: z.string().min(1),
    isActive: z.boolean().optional()
  })).optional()
}).partial();

export const addSubcategorySchema = z.object({
  name: z.string().trim().min(1, 'Subcategory name is required').max(100)
});
