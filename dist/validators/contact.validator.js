"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitContactSchema = exports.countLinks = exports.MAX_LINKS_PER_MESSAGE = void 0;
const zod_1 = require("zod");
// Collapse whitespace / strip control characters so stored text is predictable and can't smuggle
// terminal or header-injection characters into notification emails.
const stripControlChars = (v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
const singleLine = (v) => stripControlChars(v).replace(/\s+/g, ' ').trim();
const multiLine = (v) => stripControlChars(v)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
// Accepts "+91 98765-43210", "(022) 1234 5678" … and stores "+919876543210" style digits.
// 7–15 digits (E.164 maximum); anything else is rejected rather than guessed at.
const normalisePhone = (v) => {
    const trimmed = v.trim();
    const digits = trimmed.replace(/\D/g, '');
    return (trimmed.startsWith('+') ? '+' : '') + digits;
};
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
        phone: zod_1.z
            .string()
            .optional()
            .transform((v) => (v === undefined || v.trim() === '' ? undefined : normalisePhone(v)))
            .refine((v) => v === undefined || /^\+?\d{7,15}$/.test(v), { message: 'Enter a valid phone number (7–15 digits)' }),
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
