import { z } from 'zod';
import { InvitationStatus, RsvpStatus } from '../models/Invitee';
import { optionalPhoneSchema } from './phone.validator';

export const createInviteeSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
    email: z.string().trim().toLowerCase().email('Invalid email address').optional().or(z.literal('')),
    mobile: optionalPhoneSchema,
    companyName: z.string().trim().max(200, 'Company must be 200 characters or less').optional(),
    company: z.string().trim().max(200, 'Company must be 200 characters or less').optional(),
    professionalIdentity: z.string().trim().max(100).optional(),
    secondaryIdentity: z.string().trim().max(100).optional(),
    dietaryPreference: z.string().max(200).optional(),
    sessionAccess: z.array(z.object({
      sessionId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID'),
      allowed: z.boolean().optional().default(true)
    })).max(500).optional()
  }).refine(data => !!(data.email || data.mobile), {
    message: 'Either email or mobile must be provided',
    path: ['email']
  })
});

export const updateInviteeSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().toLowerCase().email('Invalid email address').optional().or(z.literal('')),
    mobile: optionalPhoneSchema,
    companyName: z.string().trim().max(200, 'Company must be 200 characters or less').optional(),
    company: z.string().trim().max(200, 'Company must be 200 characters or less').optional(),
    professionalIdentity: z.string().trim().max(100).optional(),
    secondaryIdentity: z.string().trim().max(100).optional(),
    dietaryPreference: z.string().max(200).optional(),
    rsvpStatus: z.enum(['PENDING', 'ACCEPTED', 'DECLINED']).optional(),
    sessionAccess: z.array(z.object({
      sessionId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID'),
      allowed: z.boolean().optional().default(true)
    })).max(500).optional()
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
    inviteeIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid invitee ID')).min(1, 'At least one invitee required').max(5000, 'Too many invitees in one request'),
    sessionAccess: z.array(z.object({
      sessionId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID'),
      allowed: z.boolean()
    }))
  })
});
