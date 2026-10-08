"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateSessionSchema = exports.createSessionSchema = void 0;
const zod_1 = require("zod");
const Session_1 = require("../models/Session");
exports.createSessionSchema = zod_1.z.object({
    body: zod_1.z.object({
        name: zod_1.z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
        schedule: zod_1.z.object({
            start: zod_1.z.string().datetime(),
            end: zod_1.z.string().datetime()
        }).refine(data => new Date(data.end) > new Date(data.start), {
            message: 'End date must be after start date',
            path: ['end']
        }),
        accessControl: zod_1.z.nativeEnum(Session_1.AccessControl).default(Session_1.AccessControl.NO_RESTRICTION),
        validateAgainstOtherSessions: zod_1.z.boolean().default(false),
        inviteeSource: zod_1.z.nativeEnum(Session_1.InviteeSource).default(Session_1.InviteeSource.NEW_LIST),
        sourceSessionId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID').nullable().optional()
    }).refine(data => {
        if (data.inviteeSource === Session_1.InviteeSource.COPY_SESSION && !data.sourceSessionId) {
            return false;
        }
        return true;
    }, {
        message: 'sourceSessionId is required when inviteeSource is COPY_SESSION',
        path: ['sourceSessionId']
    })
});
exports.updateSessionSchema = zod_1.z.object({
    body: zod_1.z.object({
        name: zod_1.z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less').optional(),
        schedule: zod_1.z.object({
            start: zod_1.z.string().datetime(),
            end: zod_1.z.string().datetime()
        }).refine(data => new Date(data.end) > new Date(data.start), {
            message: 'End date must be after start date',
            path: ['end']
        }).optional(),
        accessControl: zod_1.z.nativeEnum(Session_1.AccessControl).optional(),
        validateAgainstOtherSessions: zod_1.z.boolean().optional(),
        inviteeSource: zod_1.z.nativeEnum(Session_1.InviteeSource).optional(),
        sourceSessionId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid session ID').nullable().optional()
    })
});
