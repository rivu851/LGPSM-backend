import { z } from 'zod';

export const optionalPhoneSchema = z
  .string()
  .regex(/^\d{7,15}$/, 'Enter a valid phone number (7–15 digits)')
  .optional()
  .or(z.literal(''));
