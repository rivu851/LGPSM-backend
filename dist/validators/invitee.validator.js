"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bulkUpdateSessionAccessSchema = exports.updateSessionAccessSchema = exports.updateInviteeSchema = exports.createInviteeSchema = void 0;
const zod_1 = require("zod");
const mobileValidation = zod_1.z.string().optional().or(zod_1.z.literal('')).refine(val => {
    if (!val || !val.trim())
        return true;
    const digits = val.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15;
}, { message: 'Mobile number must contain between 7 and 15 digits' });
exports.createInviteeSchema = zod_1.z.object({
    body: zod_1.z.object({
        name: zod_1.z.string().trim().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
        email: zod_1.z.string().trim().toLowerCase().email('Invalid email address').optional().or(zod_1.z.literal('')),
        mobile: mobileValidation,
        companyName: zod_1.z.string().optional(),
        company: zod_1.z.string().optional(),
        professionalIdentity: zod_1.z.string().trim().max(100).optional(),
        dietaryPreference: zod_1.z.string().optional(),
        sessionAccess: zod_1.z.array(zod_1.z.object({
            sessionId: zod_1.z.string(),
            allowed: zod_1.z.boolean().optional().default(true)
        })).optional()
    }).refine(data => !!(data.email || data.mobile), {
        message: 'Either email or mobile must be provided',
        path: ['email']
    })
});
exports.updateInviteeSchema = zod_1.z.object({
    body: zod_1.z.object({
        name: zod_1.z.string().trim().min(1).max(100).optional(),
        email: zod_1.z.string().trim().toLowerCase().email('Invalid email address').optional().or(zod_1.z.literal('')),
        mobile: mobileValidation,
        companyName: zod_1.z.string().optional(),
        company: zod_1.z.string().optional(),
        professionalIdentity: zod_1.z.string().trim().max(100).optional(),
        dietaryPreference: zod_1.z.string().optional(),
        rsvpStatus: zod_1.z.enum(['PENDING', 'ACCEPTED', 'DECLINED']).optional(),
        sessionAccess: zod_1.z.array(zod_1.z.object({
            sessionId: zod_1.z.string(),
            allowed: zod_1.z.boolean().optional().default(true)
        })).optional()
    })
});
exports.updateSessionAccessSchema = zod_1.z.object({
    body: zod_1.z.object({
        sessionAccess: zod_1.z.array(zod_1.z.object({
            sessionId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID'),
            allowed: zod_1.z.boolean()
        }))
    })
});
exports.bulkUpdateSessionAccessSchema = zod_1.z.object({
    body: zod_1.z.object({
        inviteeIds: zod_1.z.array(zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid invitee ID')).min(1, 'At least one invitee required'),
        sessionAccess: zod_1.z.array(zod_1.z.object({
            sessionId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID'),
            allowed: zod_1.z.boolean()
        }))
    })
});
