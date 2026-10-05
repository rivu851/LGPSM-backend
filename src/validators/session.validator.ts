import { z } from 'zod';
import { AccessControl, InviteeSource } from '../models/Session';

export const createSessionSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
    schedule: z.object({
      start: z.string().datetime(),
      end: z.string().datetime()
    }).refine(data => new Date(data.end) > new Date(data.start), {
      message: 'End date must be after start date',
      path: ['end']
    }),
    accessControl: z.nativeEnum(AccessControl).default(AccessControl.NO_RESTRICTION),
    validateAgainstOtherSessions: z.boolean().default(false),
    inviteeSource: z.nativeEnum(InviteeSource).default(InviteeSource.NEW_LIST),
    sourceSessionId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID').nullable().optional()
  }).refine(data => {
    if (data.inviteeSource === InviteeSource.COPY_SESSION && !data.sourceSessionId) {
      return false;
    }
    return true;
  }, {
    message: 'sourceSessionId is required when inviteeSource is COPY_SESSION',
    path: ['sourceSessionId']
  })
});

export const updateSessionSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less').optional(),
    schedule: z.object({
      start: z.string().datetime(),
      end: z.string().datetime()
    }).refine(data => new Date(data.end) > new Date(data.start), {
      message: 'End date must be after start date',
      path: ['end']
    }).optional(),
    accessControl: z.nativeEnum(AccessControl).optional(),
    validateAgainstOtherSessions: z.boolean().optional(),
    inviteeSource: z.nativeEnum(InviteeSource).optional(),
    sourceSessionId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID').nullable().optional()
  })
});
