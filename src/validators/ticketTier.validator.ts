import { z } from 'zod';

export const createTicketTierSchema = z.object({
  name: z.string().min(1).max(100),
  price: z.number().min(0),
  // one platform currency: a tier is priced in rupees (the default), anything else is refused
  currency: z.literal('INR').optional(),
  capacity: z.number().int().positive(),
  isActive: z.boolean().optional()
});

export const updateTicketTierSchema = createTicketTierSchema.partial();
