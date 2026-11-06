import { z } from 'zod';
import { optionalPhoneSchema } from './phone.validator';

export const scanCheckInSchema = z.object({
  body: z.object({
    qrCode: z.string().min(1, 'qrCode is required'),
    eventId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid event ID').optional(),
    sessionId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID').optional()
  })
});

export const manualCheckInSchema = z.object({
  body: z.object({
    eventId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid event ID'),
    inviteeId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid invitee ID').optional(),
    email: z.string().email('Invalid email address').optional().or(z.literal('')),
    mobile: optionalPhoneSchema,
    sessionId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID').optional()
  }).refine(data => data.inviteeId || data.email || data.mobile, {
    message: 'Either inviteeId, email, or mobile must be provided for manual identification',
    path: ['inviteeId']
  })
});
