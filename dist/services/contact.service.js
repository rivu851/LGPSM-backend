"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.contactService = exports.DUPLICATE_WINDOW_MS = void 0;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const ContactMessage_1 = require("../models/ContactMessage");
const alert_service_1 = require("./alert.service");
// An identical message from the same address inside this window is treated as a retry / double click
exports.DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const sha256 = (v) => crypto_1.default.createHash('sha256').update(v).digest('hex');
const normaliseForFingerprint = (v) => v.toLowerCase().replace(/\s+/g, ' ').trim();
const toReceipt = (doc, duplicate) => ({
    id: String(doc.id),
    status: doc.status,
    receivedAt: doc.createdAt,
    duplicate
});
exports.contactService = {
    // Persists first, then alerts admins. A failure while alerting is logged but never undoes (or fails)
    // a request that was already stored.
    async submit(input, meta = {}) {
        const fingerprint = sha256(`${input.email}\n${normaliseForFingerprint(input.message)}`);
        const recent = await ContactMessage_1.ContactMessage.findOne({
            fingerprint,
            createdAt: { $gte: new Date(Date.now() - exports.DUPLICATE_WINDOW_MS) }
        }).select('status createdAt');
        if (recent)
            return toReceipt(recent, true);
        const bucket = Math.floor(Date.now() / exports.DUPLICATE_WINDOW_MS);
        let doc;
        try {
            doc = await ContactMessage_1.ContactMessage.create({
                name: input.name,
                email: input.email,
                phone: input.phone,
                message: input.message,
                fingerprint,
                dedupeKey: `${fingerprint}:${bucket}`,
                ipHash: meta.ip ? crypto_1.default.createHmac('sha256', env_1.env.JWT_SECRET).update(meta.ip).digest('hex').slice(0, 32) : undefined,
                userAgent: meta.userAgent?.slice(0, 200)
            });
        }
        catch (err) {
            // A concurrent identical request won the race for the unique dedupe key: report that one
            if (err?.code === 11000) {
                const winner = await ContactMessage_1.ContactMessage.findOne({ fingerprint }).sort({ createdAt: -1 }).select('status createdAt');
                if (winner)
                    return toReceipt(winner, true);
            }
            throw err;
        }
        try {
            const preview = input.message.length > 200 ? `${input.message.slice(0, 200)}…` : input.message;
            await alert_service_1.alertService.notifyAdmins('newContactMessage', {
                type: 'CONTACT_MESSAGE',
                title: 'New contact message',
                message: `${input.name} <${input.email}>${input.phone ? ` (${input.phone})` : ''}: ${preview}`,
                entityType: 'CONTACT_MESSAGE',
                entityId: doc._id
            });
        }
        catch (err) {
            console.error('Contact message stored but admin notification failed:', err.message);
        }
        return toReceipt(doc, false);
    }
};
