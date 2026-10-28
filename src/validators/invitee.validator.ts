import { z } from 'zod';
import { InvitationStatus, RsvpStatus } from '../models/Invitee';

const mobileValidation = z.string().optional().or(z.literal('')).refine(val => {
  if (!val || !val.trim()) return true;
  const digits = val.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}, { message: 'Mobile number must contain between 7 and 15 digits' });

export const createInviteeSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
    email: z.string().trim().toLowerCase().email('Invalid email address').optional().or(z.literal('')),
    mobile: mobileValidation,
    companyName: z.string().optional(),
    company: z.string().optional(),
    professionalIdentity: z.string().trim().max(100).optional(),
    dietaryPreference: z.string().optional(),
    sessionAccess: z.array(z.object({
      sessionId: z.string(),
      allowed: z.boolean().optional().default(true)
    })).optional()
  }).refine(data => !!(data.email || data.mobile), {
    message: 'Either email or mobile must be provided',
    path: ['email']
  })
});

export const updateInviteeSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().toLowerCase().email('Invalid email address').optional().or(z.literal('')),
    mobile: mobileValidation,
    companyName: z.string().optional(),
    company: z.string().optional(),
    professionalIdentity: z.string().trim().max(100).optional(),
    dietaryPreference: z.string().optional(),
    rsvpStatus: z.enum(['PENDING', 'ACCEPTED', 'DECLINED']).optional(),
    sessionAccess: z.array(z.object({
      sessionId: z.string(),
      allowed: z.boolean().optional().default(true)
    })).optional()
  })
});

export const updateSessionAccessSchema = z.object({
  body: z.object({
    sessionAccess: z.array(z.object({
      sessionId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID'),
      allowed: z.boolean()
    }))
  })
});

export const bulkUpdateSessionAccessSchema = z.object({
  body: z.object({
    inviteeIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid invitee ID')).min(1, 'At least one invitee required'),
    sessionAccess: z.array(z.object({
      sessionId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID'),
      allowed: z.boolean()
    }))
  })
});
