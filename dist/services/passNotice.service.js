"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.passNoticeService = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const PassNotice_1 = require("../models/PassNotice");
const Event_1 = require("../models/Event");
const Invitee_1 = require("../models/Invitee");
const email_provider_1 = require("../utils/email.provider");
const whatsapp_service_1 = require("./whatsapp.service");
const alert_service_1 = require("./alert.service");
const auditLog_service_1 = require("./auditLog.service");
const invitationContent_1 = require("../utils/invitationContent");
const qrPayload_1 = require("../utils/qrPayload");
const credentialTokens_1 = require("../utils/credentialTokens");
const tokenCipher_1 = require("../utils/tokenCipher");
// "Your access pass was replaced / revoked" messages. Same guarantees as the cancellation notices: stored first and sent
// afterwards (the credential change never depends on a provider), one claimed attempt per channel (no duplicates), honest
// states (SENT = the provider accepted it; UNAVAILABLE = not configured; UNKNOWN = interrupted, retried only with an explicit
// acknowledgement). The reason category is internal and is never put in a guest message.
const STALE_SENDING_MS = 10 * 60 * 1000;
const escapeHtml = (v) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function replacedEmail(a) {
    return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#15191c">
<h2 style="margin:0 0 12px">Your new access pass</h2>
<p>Dear ${escapeHtml(a.guest)},</p>
<p>We have issued you a new access pass for <strong>${escapeHtml(a.title)}</strong>${a.when ? ` (${escapeHtml(a.when)})` : ''}. <strong>Your previous pass no longer works</strong>; please use only this one.</p>
<p><img src="cid:${a.cid}" alt="Your access pass" style="max-width:100%;border:1px solid #e0e0e0;border-radius:8px"></p>
${a.link ? `<p><a href="${escapeHtml(a.link)}">Open your invitation online</a> (your invitation link has not changed)</p>` : ''}
<p style="color:#6b7280;font-size:12px">Your RSVP has not changed.</p></div>`;
}
function revokedEmail(a) {
    return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#15191c">
<h2 style="margin:0 0 12px">Your access pass was withdrawn</h2>
<p>Dear ${escapeHtml(a.guest)},</p>
<p>Your access pass for <strong>${escapeHtml(a.title)}</strong> is <strong>no longer valid</strong> and cannot be used for entry.</p>
<p>Your invitation link still works for the event details and your RSVP.</p>
${a.contact ? `<p>Questions? Contact the organizer on ${escapeHtml(a.contact)}.</p>` : ''}
<p style="color:#6b7280;font-size:12px">Your RSVP has not changed.</p></div>`;
}
exports.passNoticeService = {
    /** A SENDING row older than this was interrupted: it may or may not have gone out, so it is never re-sent automatically. */
    async settleStaleSending(filter = {}) {
        const cutoff = new Date(Date.now() - STALE_SENDING_MS);
        for (const key of ['email', 'whatsapp']) {
            await PassNotice_1.PassNotice.updateMany({ ...filter, [`${key}.status`]: 'SENDING', [`${key}.lastAttemptAt`]: { $lt: cutoff } }, { $set: { [`${key}.status`]: 'UNKNOWN', [`${key}.failureReason`]: 'Interrupted while sending: it is not known whether this message was sent. Retrying may send a duplicate.' } });
        }
    },
    /** Sends what is pending for one notice. `retry` also takes FAILED/UNAVAILABLE; `includeUnknown` also UNKNOWN (explicit opt-in). */
    async processNotice(noticeId, opts = {}) {
        await this.settleStaleSending({ _id: noticeId });
        const sendable = opts.retry ? ['PENDING', 'FAILED', 'UNAVAILABLE', ...(opts.includeUnknown ? ['UNKNOWN'] : [])] : ['PENDING'];
        const totals = { attempted: 0, sent: 0, failed: 0, unavailable: 0 };
        for (const key of ['email', 'whatsapp']) {
            const claimed = await PassNotice_1.PassNotice.findOneAndUpdate({ _id: noticeId, [`${key}.status`]: { $in: sendable } }, { $set: { [`${key}.status`]: 'SENDING', [`${key}.lastAttemptAt`]: new Date() }, $inc: { [`${key}.attempts`]: 1 } }, { new: true }).lean();
            if (!claimed)
                continue;
            const outcome = await this.sendOne(key, claimed);
            totals.attempted++;
            totals[outcome.state === 'SENT' ? 'sent' : outcome.state === 'FAILED' ? 'failed' : 'unavailable']++;
            await PassNotice_1.PassNotice.updateOne({ _id: noticeId }, {
                $set: outcome.state === 'SENT'
                    ? { [`${key}.status`]: 'SENT', [`${key}.sentAt`]: new Date(), [`${key}.failureReason`]: null, ...(outcome.messageId ? { [`${key}.providerMessageId`]: outcome.messageId } : {}) }
                    : { [`${key}.status`]: outcome.state, [`${key}.failureReason`]: outcome.reason }
            });
        }
        if (totals.attempted > 0 && totals.failed + totals.unavailable > 0)
            await this.reportProblem(noticeId, totals);
        return totals;
    },
    async sendOne(key, notice) {
        const invitee = await Invitee_1.Invitee.findById(notice.inviteeId).select('+qrTokenCipher +invitationTokenCipher invitationTokenHash qrTokenHash name email mobile credentialVersion credentialRevokedAt eventId');
        const event = await Event_1.Event.findById(notice.eventId).select('title schedule contactNumber status organizerId media cardInfo categoryId subcategoryId templateId format location description');
        if (!invitee || !event)
            return { state: 'FAILED', reason: 'The guest or event no longer exists' };
        const when = event.schedule?.start ? (0, invitationContent_1.formatCardDate)(new Date(event.schedule.start)) : '';
        try {
            let card;
            let link = '';
            if (notice.kind === 'REPLACED') {
                // never send the guest a pass that has since been superseded or revoked
                if ((invitee.credentialVersion || 1) !== notice.credentialVersion || invitee.credentialRevokedAt)
                    return { state: 'FAILED', reason: 'A newer change was made to this pass, so this message was not sent' };
                const raw = (0, tokenCipher_1.decryptToken)(invitee.qrTokenCipher);
                if (!raw)
                    return { state: 'FAILED', reason: 'The new pass could not be prepared' };
                const { invitationService } = await Promise.resolve().then(() => __importStar(require('./invitation.service')));
                card = await invitationService.renderPassCard(event, invitee, raw);
                // the guest's own (unchanged) invitation link: the pass itself is in the card above
                const invitation = (0, credentialTokens_1.readInvitationToken)(invitee);
                link = invitation ? (0, qrPayload_1.invitationUrlFor)(invitation) : '';
            }
            if (key === 'email') {
                if (!invitee.email)
                    return { state: 'UNAVAILABLE', reason: 'No email address on record' };
                if (notice.kind === 'REPLACED') {
                    const cid = `pass-${invitee._id}`;
                    await (0, email_provider_1.sendEmail)(invitee.email, `Your new access pass: ${event.title}`, replacedEmail({ guest: invitee.name, title: event.title, when, link, cid }), [{ filename: 'access-pass.png', content: card, cid, contentType: 'image/png' }]);
                }
                else {
                    await (0, email_provider_1.sendEmail)(invitee.email, `Access pass withdrawn: ${event.title}`, revokedEmail({ guest: invitee.name, title: event.title, contact: event.contactNumber }));
                }
                return { state: 'SENT' };
            }
            if (!invitee.mobile)
                return { state: 'UNAVAILABLE', reason: 'No mobile number on record' };
            const { messageId } = await whatsapp_service_1.whatsappService.sendPassWhatsApp({ kind: notice.kind, recipientPhone: invitee.mobile, inviteeName: invitee.name, eventTitle: event.title, eventDate: when, cardBuffer: card });
            return { state: 'SENT', messageId };
        }
        catch (e) {
            const msg = String(e?.message || '');
            if (msg === 'PROVIDER_NOT_CONFIGURED')
                return { state: 'UNAVAILABLE', reason: 'Email provider is not configured' };
            if (key === 'whatsapp' && /^(WHATSAPP_CONFIG_MISSING|WHATSAPP_PASS_TEMPLATE_NOT_CONFIGURED)/.test(msg))
                return { state: 'UNAVAILABLE', reason: (0, whatsapp_service_1.describeWhatsAppError)(msg) };
            return { state: 'FAILED', reason: key === 'whatsapp' ? (0, whatsapp_service_1.describeWhatsAppError)(msg) : msg === 'FAILED_TO_SEND_EMAIL' ? 'The email provider did not accept the message' : msg.slice(0, 200) };
        }
    },
    async reportProblem(noticeId, totals) {
        const n = await PassNotice_1.PassNotice.findById(noticeId).lean();
        const ev = n && (await Event_1.Event.findById(n.eventId).select('title organizerId').lean());
        if (!n || !ev)
            return;
        await alert_service_1.alertService.notifyUser(ev.organizerId, {
            type: 'EVENT', title: 'An access-pass message was not sent',
            message: `A ${n.kind === 'REPLACED' ? 'replacement' : 'revocation'} message for "${ev.title}" could not be sent (${totals.failed + totals.unavailable}). Open the event's delivery history to see why and retry.`,
            entityType: 'Event', entityId: n.eventId
        });
        await auditLog_service_1.auditLogService.record({
            actorId: n.organizerId, actorRole: 'ORGANIZER', eventId: n.eventId, organizerId: n.organizerId, action: 'PASS_NOTICE_PROBLEM', entityType: 'Invitee', entityId: n.inviteeId,
            status: 'FAILED', description: 'Access-pass message not sent', metadata: totals
        });
    },
    /** Retry the notices of an event (optionally one guest). Unknown outcomes need `includeUnknown`. */
    async retry(eventId, opts = {}) {
        const filter = { eventId };
        if (opts.inviteeId && mongoose_1.default.Types.ObjectId.isValid(opts.inviteeId))
            filter.inviteeId = opts.inviteeId;
        const open = ['FAILED', 'UNAVAILABLE', ...(opts.includeUnknown ? ['UNKNOWN'] : [])];
        const notices = await PassNotice_1.PassNotice.find({ ...filter, $or: [{ 'email.status': { $in: open } }, { 'whatsapp.status': { $in: open } }] }).select('_id').lean();
        const totals = { attempted: 0, sent: 0, failed: 0, unavailable: 0 };
        for (const n of notices) {
            const t = await this.processNotice(n._id, { retry: true, includeUnknown: opts.includeUnknown });
            for (const k of Object.keys(totals))
                totals[k] += t[k];
        }
        return totals;
    },
    /** After a restart: send what was left PENDING. */
    async resumeAll() {
        const ids = await PassNotice_1.PassNotice.find({ $or: [{ 'email.status': 'PENDING' }, { 'whatsapp.status': 'PENDING' }] }).select('_id').lean();
        for (const n of ids)
            await this.processNotice(n._id).catch((e) => console.error('Pass notice resume failed:', e?.message));
        await this.settleStaleSending();
    }
};
