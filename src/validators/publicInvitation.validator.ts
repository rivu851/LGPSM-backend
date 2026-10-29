import { z } from 'zod';
import { RsvpStatus } from '../models/Invitee';

export const submitRsvpSchema = z.object({
  body: z.object({
    rsvpStatus: z.nativeEnum(RsvpStatus, {
      message: 'rsvpStatus must be ACCEPTED or DECLINED'
    }),
    dietaryPreference: z.string().max(100).optional(),
    dietarySelections: z.array(z.object({
      title: z.string().trim().min(1).max(100),
      value: z.string().trim().min(1).max(60)
    })).max(50).optional()
  })
});
