"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionalPhoneSchema = void 0;
const zod_1 = require("zod");
exports.optionalPhoneSchema = zod_1.z
    .string()
    .regex(/^\d{7,15}$/, 'Enter a valid phone number (7–15 digits)')
    .optional()
    .or(zod_1.z.literal(''));
