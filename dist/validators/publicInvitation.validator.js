"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitRsvpSchema = void 0;
const zod_1 = require("zod");
const Invitee_1 = require("../models/Invitee");
exports.submitRsvpSchema = zod_1.z.object({
    body: zod_1.z.object({
        rsvpStatus: zod_1.z.nativeEnum(Invitee_1.RsvpStatus, {
            message: 'rsvpStatus must be ACCEPTED or DECLINED'
        }),
        dietaryPreference: zod_1.z.string().max(100).optional(),
        dietarySelections: zod_1.z.array(zod_1.z.object({
            title: zod_1.z.string().trim().min(1).max(100),
            value: zod_1.z.string().trim().min(1).max(60)
        })).max(50).optional()
    })
});
