"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitContactSchema = exports.countLinks = exports.MAX_LINKS_PER_MESSAGE = void 0;
const zod_1 = require("zod");
const phone_validator_1 = require("./phone.validator");
// Collapse whitespace / strip control characters so stored text is predictable and can't smuggle
// terminal or header-injection characters into notification emails.
const stripControlChars = (v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
const singleLine = (v) => stripControlChars(v).replace(/\s+/g, ' ').trim();
const multiLine = (v) => stripControlChars(v)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
exports.MAX_LINKS_PER_MESSAGE = 2;
const countLinks = (text) => (text.match(/https?:\/\/|www\./gi) || []).length;
exports.countLinks = countLinks;
exports.submitContactSchema = zod_1.z.object({
    body: zod_1.z.object({
        name: zod_1.z
            .string({ message: 'Name is required' })
            .transform(singleLine)
            .pipe(zod_1.z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name must be at most 100 characters')),
        email: zod_1.z
            .string({ message: 'Email is required' })
            .transform((v) => singleLine(v).toLowerCase())
            .pipe(zod_1.z.string().max(254, 'Email is too long').email('Enter a valid email address')),
        phone: phone_validator_1.optionalPhoneSchema.transform((v) => v || undefined),
        message: zod_1.z
            .string({ message: 'Message is required' })
            .transform(multiLine)
            .pipe(zod_1.z
            .string()
            .min(10, 'Message must be at least 10 characters')
            .max(2000, 'Message must be at most 2000 characters')
            .refine((v) => (0, exports.countLinks)(v) <= exports.MAX_LINKS_PER_MESSAGE, { message: 'Please remove links from your message' })),
        // Honeypot: hidden in the UI, so only automated form-fillers put anything here
        website: zod_1.z.string().max(200).optional()
    })
});
