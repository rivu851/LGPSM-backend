"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.manualCheckInSchema = exports.scanCheckInSchema = void 0;
const zod_1 = require("zod");
const phone_validator_1 = require("./phone.validator");
exports.scanCheckInSchema = zod_1.z.object({
    body: zod_1.z.object({
        qrCode: zod_1.z.string().min(1, 'qrCode is required'),
        eventId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid event ID').optional(),
        sessionId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID').optional()
    })
});
exports.manualCheckInSchema = zod_1.z.object({
    body: zod_1.z.object({
        eventId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid event ID'),
        inviteeId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid invitee ID').optional(),
        email: zod_1.z.string().email('Invalid email address').optional().or(zod_1.z.literal('')),
        mobile: phone_validator_1.optionalPhoneSchema,
        sessionId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID').optional()
    }).refine(data => data.inviteeId || data.email || data.mobile, {
        message: 'Either inviteeId, email, or mobile must be provided for manual identification',
        path: ['inviteeId']
    })
});
