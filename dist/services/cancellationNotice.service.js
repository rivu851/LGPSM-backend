"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancellationNoticeService = void 0;
exports.planRecipients = planRecipients;
const CancellationNotice_1 = require("../models/CancellationNotice");
const Event_1 = require("../models/Event");
const Invitation_1 = require("../models/Invitation");
const Invitee_1 = require("../models/Invitee");
const email_provider_1 = require("../utils/email.provider");
const whatsapp_service_1 = require("./whatsapp.service");
const alert_service_1 = require("./alert.service");
const auditLog_service_1 = require("./auditLog.service");
const invitationContent_1 = require("../utils/invitationContent");
const concurrency_1 = require("../utils/concurrency");
// "This event was cancelled" messages.
//
//  * Who: every guest an invitation was actually SENT to, whatever their RSVP. Guests only added to the list, or whose
//    every delivery attempt failed, are not told (they never heard of the event from us).
//  * How: only through the channel(s) that invitation was accepted on. A channel is never assumed to have worked.
//  * Reliability: the cancellation itself never depends on a provider. Work is stored first (CancellationNotice, unique per
//    guest) and sent afterwards; the sender re-checks the event is still cancelled and claims each channel atomically, so
//    retries and repeated requests can never produce a second message for a channel that already went out.
//  * Honesty: SENT means the provider accepted the request. Delivery is not known.
const STALE_SENDING_MS = 10 * 60 * 1000;
const SEND_CONCURRENCY = 5;
/**
 * Which guests were actually invited, and on which channels, from the delivery records that already exist.
 * A guest may have several Invitation rows (every resend adds one): any SENT delivery counts.
 */
async function planRecipients(eventId) {
    const rows = await Invitation_1.Invitation.find({ eventId }).select('inviteeId channel status emailStatus whatsappStatus').lean();
    const byInvitee = new Map();
    for (const r of rows) {
        const key = String(r.inviteeId);
        const plan = byInvitee.get(key) || { inviteeId: r.inviteeId, email: false, whatsapp: false, unknownChannel: false };
        const hasChannelDetail = r.emailStatus !== undefined || r.whatsappStatus !== undefined;
        if (hasChannelDetail) {
            if (r.emailStatus === Invitation_1.InvitationDeliveryStatus.SENT)
                plan.email = true;
            if (r.whatsappStatus === Invitation_1.InvitationDeliveryStatus.SENT)
                plan.whatsapp = true;
        }
        else if (r.status === Invitation_1.InvitationDeliveryStatus.SENT) {
            // Older rows carry only the overall status: the channel is known only when exactly one was used
            if (r.channel === Invitation_1.DeliveryChannel.EMAIL)
                plan.email = true;
            else if (r.channel === Invitation_1.DeliveryChannel.WHATSAPP)
                plan.whatsapp = true;
            else
                plan.unknownChannel = true;
        }
        byInvitee.set(key, plan);
    }
    return [...byInvitee.values()].filter((p) => p.email || p.whatsapp || p.unknownChannel);
}
const escapeHtml = (v) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function cancellationEmail(args) {
    const reason = args.reason ? `<p style="margin:16px 0;padding:12px;background:#f6f7f9;border-radius:8px"><strong>Message from the organizer:</strong><br>${escapeHtml(args.reason)}</p>` : '';
    const contact = args.contact ? `<p>Questions? Contact the organizer on ${escapeHtml(args.contact)}.</p>` : '';
    return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#15191c">
<h2 style="margin:0 0 12px">Event cancelled</h2>
<p>Dear ${escapeHtml(args.guest)},</p>
<p>We are sorry to let you know that <strong>${escapeHtml(args.title)}</strong>${args.when ? `, planned for ${escapeHtml(args.when)},` : ''} has been cancelled and will not take place.</p>
<p><strong>Your access pass is no longer valid</strong> and cannot be used for entry. You do not need to do anything.</p>
${reason}${contact}
<p style="color:#6b7280;font-size:12px">This message was sent because you were invited to this event.</p></div>`;
}
const noticeService = {
    /**
     * Stores one notice per guest who was invited. Safe to call any number of times: existing notices are left exactly
     * as they are (a notice already SENT is never reset), only missing ones are added.
     */
    async enqueueForEvent(event) {
        const plans = await planRecipients(event._id);
        let created = 0;
        for (const p of plans) {
            created += await this.enqueueOne(event, p);
        }
        return { eligible: plans.length, created };
    },
    async enqueueOne(event, plan) {
        const channel = (use) => (use ? { status: 'PENDING', attempts: 0 } : { status: 'NOT_USED', attempts: 0 });
        const res = await CancellationNotice_1.CancellationNotice.updateOne({ eventId: event._id, inviteeId: plan.inviteeId }, {
            $setOnInsert: {
                eventId: event._id,
                inviteeId: plan.inviteeId,
                organizerId: event.organizerId,
                email: channel(plan.email),
                // an invitation of unknown channel is reported rather than guessed at
                whatsapp: channel(plan.whatsapp),
                ...(plan.unknownChannel && !plan.email && !plan.whatsapp
                    ? { email: { status: 'UNAVAILABLE', attempts: 0, failureReason: 'The channel this invitation used is not recorded, so no notice was sent' } }
                    : {})
            }
        }, { upsert: true }).catch((e) => {
            if (e?.code === 11000)
                return { upsertedCount: 0 }; // a concurrent enqueue created it first
            throw e;
        });
        return res.upsertedCount ? 1 : 0;
    },
    /**
     * A send that was already running when the event was cancelled may finish afterwards. Called by it once its delivery
     * is recorded, so that guest is still told.
     */
    async enqueueLateInvitee(eventId, inviteeId) {
        const event = await Event_1.Event.findById(eventId).select('organizerId status').lean();
        if (!event || event.status !== Event_1.EventStatus.CANCELLED)
            return false;
        const plan = (await planRecipients(eventId)).find((p) => String(p.inviteeId) === String(inviteeId));
        if (!plan)
            return false;
        const created = await this.enqueueOne(event, plan);
        // the late-created notice goes out too
        this.processEvent(eventId).catch((e) => console.error('Cancellation notice dispatch failed:', e?.message));
        return created > 0;
    },
    /** A SENDING row older than this was interrupted: the message may or may not have gone out, so it is never re-sent automatically. */
    async settleStaleSending(eventId) {
        const cutoff = new Date(Date.now() - STALE_SENDING_MS);
        for (const key of ['email', 'whatsapp']) {
            await CancellationNotice_1.CancellationNotice.updateMany({ ...(eventId ? { eventId } : {}), [`${key}.status`]: 'SENDING', [`${key}.lastAttemptAt`]: { $lt: cutoff } }, { $set: { [`${key}.status`]: 'UNKNOWN', [`${key}.failureReason`]: 'Interrupted while sending: it is not known whether this message was sent. Retrying may send a duplicate.' } });
        }
    },
    /**
     * Sends what is pending for one event. `retry` also takes FAILED/UNAVAILABLE channels (an organizer's explicit action).
     * Each channel is claimed with a conditional update before anything is sent, so two workers (or a worker and a retry)
     * cannot send the same message twice.
     */
    async processEvent(eventId, opts = {}) {
        const event = await Event_1.Event.findById(eventId).select('title status schedule contactNumber organizerId cancellationReason').lean();
        // eligibility is re-checked at dispatch time: only a cancelled event sends cancellation notices
        if (!event || event.status !== Event_1.EventStatus.CANCELLED)
            return { attempted: 0, sent: 0, failed: 0, unavailable: 0 };
        await this.settleStaleSending(eventId);
        // UNKNOWN (possibly already sent) is only retried when the caller explicitly accepts the risk of a duplicate
        const sendable = opts.retry ? ['PENDING', 'FAILED', 'UNAVAILABLE', ...(opts.includeUnknown ? ['UNKNOWN'] : [])] : ['PENDING'];
        const notices = await CancellationNotice_1.CancellationNotice.find({
            eventId,
            $or: [{ 'email.status': { $in: sendable } }, { 'whatsapp.status': { $in: sendable } }]
        }).select('_id').lean();
        const totals = { attempted: 0, sent: 0, failed: 0, unavailable: 0 };
        await (0, concurrency_1.mapLimit)(notices, SEND_CONCURRENCY, async (n) => {
            for (const key of ['email', 'whatsapp']) {
                // claim: only one caller can move this channel into SENDING
                const claimed = await CancellationNotice_1.CancellationNotice.findOneAndUpdate({ _id: n._id, [`${key}.status`]: { $in: sendable } }, { $set: { [`${key}.status`]: 'SENDING', [`${key}.lastAttemptAt`]: new Date() }, $inc: { [`${key}.attempts`]: 1 } }, { new: true }).lean();
                if (!claimed)
                    continue;
                const outcome = await this.sendOne(key, claimed, event);
                totals.attempted++;
                totals[outcome.state === 'SENT' ? 'sent' : outcome.state === 'FAILED' ? 'failed' : 'unavailable']++;
                await CancellationNotice_1.CancellationNotice.updateOne({ _id: n._id }, {
                    $set: {
                        [`${key}.status`]: outcome.state,
                        ...(outcome.state === 'SENT' ? { [`${key}.sentAt`]: new Date(), [`${key}.failureReason`]: null, [`${key}.providerMessageId`]: outcome.messageId || undefined } : { [`${key}.failureReason`]: outcome.reason })
                    }
                });
            }
        });
        if (totals.attempted > 0)
            await this.reportOutcome(event, eventId, totals);
        return totals;
    },
    async sendOne(key, notice, event) {
        const invitee = await Invitee_1.Invitee.findById(notice.inviteeId).select('name email mobile').lean();
        if (!invitee)
            return { state: 'FAILED', reason: 'The guest record no longer exists' };
        const when = event.schedule?.start ? (0, invitationContent_1.formatCardDate)(new Date(event.schedule.start)) : '';
        try {
            if (key === 'email') {
                if (!invitee.email)
                    return { state: 'UNAVAILABLE', reason: 'No email address on record' };
                await (0, email_provider_1.sendEmail)(invitee.email, `Cancelled: ${event.title}`, cancellationEmail({ guest: invitee.name, title: event.title, when, reason: event.cancellationReason, contact: event.contactNumber }));
                return { state: 'SENT' };
            }
            if (!invitee.mobile)
                return { state: 'UNAVAILABLE', reason: 'No mobile number on record' };
            const { messageId } = await whatsapp_service_1.whatsappService.sendCancellationWhatsApp({ recipientPhone: invitee.mobile, inviteeName: invitee.name, eventTitle: event.title, eventDate: when });
            return { state: 'SENT', messageId };
        }
        catch (err) {
            const msg = String(err?.message || '');
            if (msg === 'PROVIDER_NOT_CONFIGURED')
                return { state: 'UNAVAILABLE', reason: 'Email provider is not configured' };
            if (key === 'whatsapp' && /^(WHATSAPP_CONFIG_MISSING|WHATSAPP_CANCELLATION_TEMPLATE_NOT_CONFIGURED)/.test(msg))
                return { state: 'UNAVAILABLE', reason: (0, whatsapp_service_1.describeWhatsAppError)(msg) };
            return { state: 'FAILED', reason: key === 'whatsapp' ? (0, whatsapp_service_1.describeWhatsAppError)(msg) : msg === 'FAILED_TO_SEND_EMAIL' ? 'The email provider did not accept the message' : msg.slice(0, 200) };
        }
    },
    /** Audit and in-app alert once a batch has been tried. Counts only: no names, addresses or message content. */
    async reportOutcome(event, eventId, totals) {
        const full = await Event_1.Event.findById(eventId).select('cancelledBy cancelledByRole organizerId').lean();
        if (full?.cancelledBy) {
            await auditLog_service_1.auditLogService.record({
                actorId: full.cancelledBy, actorRole: full.cancelledByRole, eventId, organizerId: full.organizerId,
                action: 'EVENT_CANCEL_NOTIFICATIONS', entityType: 'Event', entityId: eventId,
                status: totals.failed + totals.unavailable > 0 ? 'FAILED' : 'SUCCESS',
                description: 'Cancellation notices processed', metadata: totals
            });
        }
        if (totals.failed + totals.unavailable > 0) {
            await alert_service_1.alertService.notifyUser(event.organizerId, {
                type: 'EVENT', title: 'Some cancellation notices were not sent',
                message: `${totals.failed + totals.unavailable} cancellation notice(s) for "${event.title}" could not be sent. Open the event to see why and retry.`,
                entityType: 'Event', entityId: eventId
            });
        }
    },
    /** Organizer-facing picture of what happened, without message content. */
    async summary(eventId) {
        const notices = await CancellationNotice_1.CancellationNotice.find({ eventId }).lean();
        const invitees = await Invitee_1.Invitee.find({ _id: { $in: notices.map((n) => n.inviteeId) } }).select('name email mobile rsvpStatus').lean();
        const byId = new Map(invitees.map((i) => [String(i._id), i]));
        const blank = () => ({ PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0, UNAVAILABLE: 0, UNKNOWN: 0 });
        const channels = { email: blank(), whatsapp: blank() };
        const problems = [];
        for (const n of notices) {
            for (const key of ['email', 'whatsapp']) {
                const c = n[key];
                if (!c || c.status === 'NOT_USED')
                    continue;
                channels[key][c.status] = (channels[key][c.status] || 0) + 1;
                if (['FAILED', 'UNAVAILABLE', 'UNKNOWN'].includes(c.status)) {
                    const inv = byId.get(String(n.inviteeId));
                    problems.push({ inviteeId: n.inviteeId, name: inv?.name, channel: key, status: c.status, reason: c.failureReason, attempts: c.attempts, lastAttemptAt: c.lastAttemptAt });
                }
            }
        }
        return { guests: notices.length, channels, problems, note: 'SENT means the provider accepted the message; delivery is not confirmed.' };
    },
    /** Counts for the confirmation dialog, from the same rule the sender uses. */
    async preview(eventId) {
        const plans = await planRecipients(eventId);
        const invited = plans.length;
        const totalInvitees = await Invitee_1.Invitee.countDocuments({ eventId });
        return {
            invitedGuests: invited,
            byChannel: { email: plans.filter((p) => p.email).length, whatsapp: plans.filter((p) => p.whatsapp).length, unknownChannel: plans.filter((p) => p.unknownChannel && !p.email && !p.whatsapp).length },
            notInvited: Math.max(totalInvitees - invited, 0),
            whatsappNoticesAvailable: !!(process.env.WHATSAPP_CANCELLATION_TEMPLATE) && !!process.env.WHATSAPP_ACCESS_TOKEN
        };
    },
    /** After a restart: send what was left PENDING for cancelled events. */
    async resumeAll() {
        const ids = await CancellationNotice_1.CancellationNotice.distinct('eventId', { $or: [{ 'email.status': 'PENDING' }, { 'whatsapp.status': 'PENDING' }] });
        for (const id of ids)
            await this.processEvent(id).catch((e) => console.error('Cancellation notice resume failed:', e?.message));
        await this.settleStaleSending();
    }
};
exports.cancellationNoticeService = noticeService;
