"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.invitationService = exports.SKIPPED_IN_PROGRESS = exports.SKIPPED_PASS_REVOKED = exports.SKIPPED_EVENT_CANCELLED = exports.SKIPPED_ALREADY_INVITED = exports.SKIPPED_NO_CONTACT = void 0;
exports.buildFormalInvitationEmailHTML = buildFormalInvitationEmailHTML;
exports.channelsForInvitee = channelsForInvitee;
const qrcode_1 = __importDefault(require("qrcode"));
const invitationContent_1 = require("../utils/invitationContent");
const alert_service_1 = require("./alert.service");
const mongoose_1 = __importDefault(require("mongoose"));
const Event_1 = require("../models/Event");
const cancellationNotice_service_1 = require("./cancellationNotice.service");
const credential_service_1 = require("./credential.service");
const Invitee_1 = require("../models/Invitee");
const Invitation_1 = require("../models/Invitation");
const Session_1 = require("../models/Session");
const User_1 = require("../models/User");
const invitation_util_1 = require("../utils/invitation.util");
const qr_util_1 = require("../utils/qr.util");
const qrPayload_1 = require("../utils/qrPayload");
const credentialTokens_1 = require("../utils/credentialTokens");
const tokenCipher_1 = require("../utils/tokenCipher");
const email_provider_1 = require("../utils/email.provider");
const whatsapp_service_1 = require("./whatsapp.service");
const invitationCard_service_1 = require("./invitationCard.service");
const concurrency_1 = require("../utils/concurrency");
const context_1 = require("./cardTemplates/context");
const cardInfo_1 = require("../utils/cardInfo");
const resolveImageBase64_1 = require("../utils/resolveImageBase64");
const emailImages_1 = require("./email/emailImages");
const invitationEmail_1 = require("./email/invitationEmail");
const inviteeClaim_1 = require("../utils/inviteeClaim");
const admissionWindow_1 = require("../utils/admissionWindow");
function buildFormalInvitationEmailHTML(params) {
    // The letter itself lives in services/email/invitationEmail.ts (one template for invitations and reminders)
    return (0, invitationEmail_1.buildInvitationEmail)({ ...params, qrCid: params.cid });
}
// Guests in one batch are prepared a few at a time: each one is mostly waiting on image rendering and the mail /
// WhatsApp providers, so a small amount of overlap cuts a big batch's time without flooding either provider.
const sendConcurrency = () => Math.min(Math.max(parseInt(process.env.INVITATION_SEND_CONCURRENCY || '3', 10) || 3, 1), 8);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
exports.SKIPPED_NO_CONTACT = 'No email address or WhatsApp number';
exports.SKIPPED_ALREADY_INVITED = 'Already invited';
exports.SKIPPED_EVENT_CANCELLED = 'The event was cancelled';
exports.SKIPPED_PASS_REVOKED = 'Pass revoked: use Replace Access Pass';
exports.SKIPPED_IN_PROGRESS = 'A delivery to this guest is already in progress';
/** No pass is issued for an event that is over: it could not be used, and it is a message about the past. */
function assertEventCanIssue(event) {
    if (event.status === Event_1.EventStatus.CANCELLED)
        throw new Error('EVENT_CANCELLED');
    const window = (0, admissionWindow_1.effectiveAdmission)(event);
    if (event.status === Event_1.EventStatus.COMPLETED || (window && (0, admissionWindow_1.admissionState)(window, new Date()) === 'CLOSED'))
        throw new Error('EVENT_ENDED');
}
/** Read fresh on every use: a cancellation can land while a long send is running. */
const eventIsCancelled = async (eventId) => !!(await Event_1.Event.exists({ _id: eventId, status: Event_1.EventStatus.CANCELLED }));
/**
 * Channels to attempt for one guest. EMAIL or WHATSAPP is an explicit request, so a missing contact is a real
 * failure. BOTH ("All") uses whichever of the guest's contacts are usable; a guest with neither is skipped before
 * anything is changed (no new token, invitation status untouched).
 */
function channelsForInvitee(channel, invitee) {
    if (channel !== Invitation_1.DeliveryChannel.BOTH) {
        return { email: channel === Invitation_1.DeliveryChannel.EMAIL, whatsapp: channel === Invitation_1.DeliveryChannel.WHATSAPP };
    }
    return {
        email: !!invitee.email && EMAIL_PATTERN.test(invitee.email.trim()),
        whatsapp: whatsapp_service_1.whatsappService.normalizePhoneNumber(invitee.mobile).length >= 10,
    };
}
/** The organizer's logo for the bottom of invitation emails (null when none was uploaded or it cannot be read) */
async function organizerBrand(organizerId) {
    if (!organizerId)
        return { logo: null };
    const organizer = await User_1.User.findById(organizerId).select('fullName profile.organizationName profile.logoKey').lean();
    const organizationName = organizer?.profile?.organizationName?.trim() || undefined; // only when the organizer has set one
    const name = organizationName || organizer?.fullName?.trim() || undefined;
    const dataUrl = await (0, resolveImageBase64_1.resolveImageKeyBase64)(organizer?.profile?.logoKey).catch(() => '');
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
    return { name, organizationName, logo: match ? { contentType: match[1], content: Buffer.from(match[2], 'base64') } : null };
}
// Rendered sample cards by event, oldest dropped first (see previewInvitationCard)
const sampleCards = new Map();
exports.invitationService = {
    async publicInvitationCard(rawToken) {
        const { event, invitee, admissionToken } = await this.publicPass(rawToken);
        return this.renderPassCard(event, invitee, admissionToken);
    },
    /**
     * The guest's entry QR on its own. Shown on the invitation page when the organizer chose not to print the QR on the card
     * ("Select data to show on card"), so the guest still has a pass to show at the door. Same checks and same credential as the card.
     */
    async publicInvitationQr(rawToken) {
        const { admissionToken } = await this.publicPass(rawToken);
        return qrcode_1.default.toBuffer((0, qrPayload_1.admissionPayloadFor)(admissionToken), { errorCorrectionLevel: 'H', margin: 4, width: 640 });
    },
    /** The guest behind an invitation link, their event, and their current admission credential; refused like the card is */
    async publicPass(rawToken) {
        if (!rawToken || typeof rawToken !== 'string')
            throw new Error('INVALID_TOKEN');
        // The link finds the guest; the pass drawn is their CURRENT admission credential, whichever pass the link was first sent with
        const invitee = await Invitee_1.Invitee.findOne((0, credentialTokens_1.invitationLookup)((0, invitation_util_1.hashToken)(rawToken))).select('+qrTokenCipher');
        if (!invitee) {
            // an address that carried an old admission credential (links sent before the two secrets were separated): say so
            if (await credential_service_1.credentialService.isSupersededToken((0, invitation_util_1.hashToken)(rawToken)))
                throw new Error('CREDENTIAL_REPLACED');
            throw new Error('INVITATION_NOT_FOUND');
        }
        const event = await Event_1.Event.findById(invitee.eventId);
        if (!event)
            throw new Error('INVITATION_NOT_FOUND');
        // The page shows a notice instead; a cancelled event's pass is never drawn (and would be refused at the door anyway)
        if (event.status === Event_1.EventStatus.CANCELLED)
            throw new Error('EVENT_CANCELLED');
        // A revoked pass is not drawn either: the page explains instead
        if (invitee.credentialRevokedAt)
            throw new Error('CREDENTIAL_REVOKED');
        // a guest from before the two secrets were separated, whose pass was stored without a recoverable copy: the link token IS their pass
        const admissionToken = (0, credentialTokens_1.readAdmissionToken)(invitee) ?? ((0, invitation_util_1.hashToken)(rawToken) === invitee.qrTokenHash ? rawToken : null);
        if (!admissionToken)
            throw new Error('INVITATION_NOT_FOUND');
        return { event, invitee, admissionToken };
    },
    /** Draws the guest's card with the QR for the ADMISSION credential `rawToken`. Used for the public card and for replacement notices. */
    async renderPassCard(event, invitee, rawToken) {
        const cardContext = await (0, context_1.loadCardContext)(event);
        const eventPhotoBase64 = await (0, resolveImageBase64_1.resolveImageKeyBase64)(event.media?.logoKey);
        const guestLines = (0, cardInfo_1.cardGuestLines)(invitee, event.cardInfo);
        const allSessions = await Session_1.Session.find({ eventId: event._id }).sort({ 'schedule.start': 1 }).lean();
        const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } = (0, invitationContent_1.buildInvitationContent)(event, allSessions, invitee);
        const invitationUrl = (0, qrPayload_1.admissionPayloadFor)(rawToken); // the QR carries the admission credential, nothing else
        const qrDataUrl = await (0, qr_util_1.generateQRCodeDataURL)(invitationUrl);
        return invitationCard_service_1.invitationCardService.generateInvitationCardPNG({
            invitee: { id: String(invitee._id), ...guestLines },
            event: {
                title: event.title,
                date: eventDate,
                dayOfWeek,
                startTime: eventTime,
                timeSub: 'ONWARDS',
                venue,
                locationSub,
                photoBase64: eventPhotoBase64,
                startIso: event.schedule?.start,
                endIso: event.schedule?.end,
                categoryName: cardContext.categoryName,
                subcategoryName: cardContext.subcategoryName,
                isVirtual: event.format === 'VIRTUAL',
                description: event.description,
                organizerName: cardContext.organizerName,
                contactNumber: event.contactNumber
            },
            sessions: assignedSessions,
            qrDataUrl,
            invitationUrl,
            cardDesign: cardContext.cardDesign,
            designSpec: cardContext.designSpec,
            cardDisplay: event.cardDisplay
        });
    },
    async sendInvitations(eventId, userOrOrganizerId, inviteeIds, channel) {
        const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
        const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
        const userRole = isUserObj ? userOrOrganizerId.role : undefined;
        let event;
        if (userRole === User_1.Role.ADMIN || userRole === 'ADMIN') {
            event = await Event_1.Event.findById(eventId);
        }
        else {
            event = await Event_1.Event.findOne({ _id: eventId, organizerId });
        }
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        // A cancelled or finished event never issues, sends or re-sends an invitation (and so never mints a pass that could be scanned)
        assertEventCanIssue(event);
        // The design follows the organizer's template, or the event's type when none was chosen (see cardTemplates/designs.ts)
        const cardContext = await (0, context_1.loadCardContext)(event);
        const cardDesign = cardContext.cardDesign;
        // the organizer's logo goes at the bottom of each invitation email (read once per send)
        const brand = await organizerBrand(event.organizerId);
        // Resolved once per event (not per invitee) — the same organizer-uploaded photo goes on
        // every invitee's card for this event.
        const eventPhotoBase64 = await (0, resolveImageBase64_1.resolveImageKeyBase64)(event.media?.logoKey);
        // Filter unique inviteeIds to prevent duplicate processing in one request
        const idsArray = Array.isArray(inviteeIds) ? inviteeIds : typeof inviteeIds === "string" ? [inviteeIds] : [];
        const validObjectIds = idsArray
            .filter((id) => mongoose_1.default.Types.ObjectId.isValid(id))
            .map((id) => new mongoose_1.default.Types.ObjectId(id));
        if (validObjectIds.length === 0)
            throw new Error('INVALID_INVITEES');
        const invitees = await Invitee_1.Invitee.find({ _id: { $in: validObjectIds }, eventId }).select('+qrTokenCipher +invitationTokenCipher');
        if (invitees.length === 0)
            throw new Error('INVALID_INVITEES');
        const results = [];
        // Load all sessions for this event once
        const allSessions = await Session_1.Session.find({ eventId }).sort({ 'schedule.start': 1 }).lean();
        // Send is for guests who have not been invited yet (e.g. ones added after the first batch). Anyone already
        // sent is skipped untouched: no new token (which would invalidate the QR they already hold) and no second
        // message. Re-delivery is the explicit Resend action.
        const alreadySent = new Set((await Invitation_1.Invitation.find({ eventId, inviteeId: { $in: invitees.map((i) => i._id) }, status: Invitation_1.InvitationDeliveryStatus.SENT }).select('inviteeId').lean())
            .map((i) => String(i.inviteeId)));
        const deliverToInvitee = async (invitee) => {
            // A send that was already running when the event was cancelled stops here, before any token or provider call
            if (await eventIsCancelled(eventId)) {
                return { inviteeId: invitee._id, inviteeName: invitee.name, inviteeMobile: invitee.mobile, status: 'SKIPPED', failureReason: exports.SKIPPED_EVENT_CANCELLED };
            }
            const use = channelsForInvitee(channel, invitee);
            if (!use.email && !use.whatsapp) {
                return { inviteeId: invitee._id, inviteeName: invitee.name, inviteeMobile: invitee.mobile, status: 'SKIPPED', failureReason: exports.SKIPPED_NO_CONTACT };
            }
            const shouldSendEmail = use.email;
            const shouldSendWhatsApp = use.whatsapp;
            // Two separate secrets: a new ADMISSION credential (the QR) and the guest's stable INVITATION token (the link)
            const rawToken = (0, invitation_util_1.generateSecureToken)();
            const tokenHash = (0, invitation_util_1.hashToken)(rawToken);
            const invitationToken = (0, credentialTokens_1.planInvitationToken)(invitee);
            const invitationUrl = (0, qrPayload_1.invitationUrlFor)(invitationToken.raw);
            const qrDataUrl = await (0, qr_util_1.generateQRCodeDataURL)((0, qrPayload_1.admissionPayloadFor)(rawToken));
            const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
            const qrBuffer = Buffer.from(base64Data, 'base64');
            let invitation = await Invitation_1.Invitation.findOne({ eventId, inviteeId: invitee._id });
            if (!invitation) {
                invitation = new Invitation_1.Invitation({
                    eventId,
                    inviteeId: invitee._id,
                    channel,
                    status: Invitation_1.InvitationDeliveryStatus.PENDING,
                    tokenHash
                });
            }
            else {
                invitation.channel = channel;
                invitation.tokenHash = tokenHash;
                invitation.status = Invitation_1.InvitationDeliveryStatus.PENDING;
                invitation.clearedAt = undefined; // a fresh delivery belongs in the visible history again
            }
            let emailSuccess = false;
            let whatsappSuccess = false;
            let emailErrReason = '';
            let whatsappErrReason = '';
            // Event/session details for this invitee, rendered in the platform time zone
            const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } = (0, invitationContent_1.buildInvitationContent)(event, allSessions, invitee);
            // Render canonical personalized invitation card PNG
            let cardBuffer;
            try {
                cardBuffer = await invitationCard_service_1.invitationCardService.generateInvitationCardPNG({
                    invitee: { id: invitee._id.toString(), ...(0, cardInfo_1.cardGuestLines)(invitee, event.cardInfo) },
                    event: {
                        id: event._id.toString(),
                        title: event.title,
                        date: eventDate,
                        dayOfWeek,
                        startTime: eventTime,
                        timeSub: 'ONWARDS',
                        venue,
                        locationSub,
                        photoBase64: eventPhotoBase64,
                        startIso: event.schedule?.start,
                        endIso: event.schedule?.end,
                        categoryName: cardContext.categoryName,
                        subcategoryName: cardContext.subcategoryName,
                        isVirtual: event.format === 'VIRTUAL',
                        description: event.description,
                        organizerName: cardContext.organizerName,
                        contactNumber: event.contactNumber
                    },
                    sessions: assignedSessions,
                    qrDataUrl,
                    invitationUrl: (0, qrPayload_1.admissionPayloadFor)(rawToken), // the card's QR (fallback) is always the admission credential
                    cardDesign,
                    designSpec: cardContext.designSpec,
                    cardDisplay: event.cardDisplay
                });
            }
            catch (err) {
                console.error('Failed to generate high-resolution invitation card PNG:', err);
                cardBuffer = qrBuffer;
            }
            // 1. Process EMAIL if selected
            if (shouldSendEmail && !(await eventIsCancelled(eventId))) {
                try {
                    if (!invitee.email)
                        throw new Error('MISSING_EMAIL');
                    const cid = `invitation-qr-${invitee._id}`;
                    const cardCid = `invitation-card-${invitee._id}`;
                    const htmlContent = buildFormalInvitationEmailHTML({
                        eventTitle: event.title,
                        inviteeName: invitee.name,
                        inviteeEmail: invitee.email,
                        eventDate,
                        eventTime,
                        venue,
                        dietaryPreference: invitee.dietaryPreference,
                        asksDietary: !!event.dietaryPreference?.enabled && Array.isArray(event.dietaryPreference?.options) && event.dietaryPreference.options.length > 0,
                        invitationUrl,
                        cid,
                        cardCid,
                        isReminder: false,
                        organizerLogoCid: brand.logo ? `organizer-logo-${invitee._id}` : undefined,
                        organizerName: brand.name,
                        organizationName: brand.organizationName,
                        startIso: event.schedule?.start,
                        endIso: event.schedule?.end,
                        locationSub,
                        isVirtual: event.format === 'VIRTUAL',
                        description: event.description,
                        contactNumber: event.contactNumber,
                        rsvpBy: event.rsvp?.enabled ? event.rsvp?.acceptanceLastDate : undefined,
                        showQr: event.cardDisplay?.qr !== false,
                    });
                    const attachments = [
                        {
                            filename: 'invitation-card.png',
                            content: cardBuffer,
                            cid: cardCid,
                            contentType: 'image/png'
                        },
                        // the QR goes in only when the email shows it on its own, i.e. there is no card image to carry it (an unused inline image
                        // would appear as a loose attachment in Gmail)
                        ...(event.cardDisplay?.qr !== false && !cardBuffer?.length ? [{
                                filename: 'invitation-qr.png',
                                content: qrBuffer,
                                cid,
                                contentType: 'image/png'
                            }] : []),
                        ...(brand.logo ? [{ filename: 'organizer-logo', content: brand.logo.content, cid: `organizer-logo-${invitee._id}`, contentType: brand.logo.contentType }] : []),
                        // the details icons, and the LGPSM logo while the organizer has none of their own
                        ...(await (0, emailImages_1.inlineImagesFor)(htmlContent))
                    ];
                    await (0, email_provider_1.sendEmail)(invitee.email, (0, invitationEmail_1.invitationEmailSubject)(event.title), htmlContent, attachments);
                    emailSuccess = true;
                    invitation.emailStatus = Invitation_1.InvitationDeliveryStatus.SENT;
                    invitation.emailFailureReason = undefined;
                }
                catch (err) {
                    emailSuccess = false;
                    emailErrReason = err.message === 'PROVIDER_NOT_CONFIGURED' ? 'Email provider not configured' : err.message;
                    invitation.emailStatus = Invitation_1.InvitationDeliveryStatus.FAILED;
                    invitation.emailFailureReason = emailErrReason;
                }
            }
            // 2. Process WHATSAPP if selected
            if (shouldSendWhatsApp && !(await eventIsCancelled(eventId))) {
                try {
                    if (!invitee.mobile)
                        throw new Error('MISSING_MOBILE');
                    // Pass the high-resolution personalized invitation card PNG buffer to Meta WhatsApp API
                    const { messageId } = await whatsapp_service_1.whatsappService.sendInvitationWhatsApp({
                        recipientPhone: invitee.mobile,
                        qrBuffer: cardBuffer,
                        inviteeName: invitee.name,
                        eventTitle: event.title,
                        eventDate,
                        eventTime,
                        venue
                    });
                    whatsappSuccess = true;
                    invitation.whatsappStatus = Invitation_1.InvitationDeliveryStatus.SENT;
                    invitation.whatsappMessageId = messageId;
                    invitation.whatsappFailureReason = undefined;
                }
                catch (err) {
                    whatsappSuccess = false;
                    whatsappErrReason = (0, whatsapp_service_1.describeWhatsAppError)(err.message);
                    invitation.whatsappStatus = Invitation_1.InvitationDeliveryStatus.FAILED;
                    invitation.whatsappFailureReason = whatsappErrReason;
                }
            }
            const anySuccess = (shouldSendEmail && emailSuccess) || (shouldSendWhatsApp && whatsappSuccess);
            if (anySuccess) {
                invitation.status = Invitation_1.InvitationDeliveryStatus.SENT;
                invitation.sentAt = new Date();
                invitation.failureReason = undefined;
                // Save the active admission credential and the invitation token, and the status, on the guest
                invitee.qrTokenHash = tokenHash;
                invitee.qrTokenCipher = (0, tokenCipher_1.encryptToken)(rawToken);
                if (invitationToken.persist) {
                    invitee.invitationTokenHash = invitationToken.hash;
                    invitee.invitationTokenCipher = invitationToken.cipher;
                }
                invitee.invitationStatus = Invitee_1.InvitationStatus.SENT;
            }
            else {
                invitation.status = Invitation_1.InvitationDeliveryStatus.FAILED;
                if (shouldSendEmail && shouldSendWhatsApp) {
                    const failures = [];
                    if (emailErrReason)
                        failures.push(`Email: ${emailErrReason}`);
                    if (whatsappErrReason)
                        failures.push(`WhatsApp: ${whatsappErrReason}`);
                    invitation.failureReason = failures.join(' | ') || 'Delivery failed';
                }
                else if (shouldSendEmail) {
                    invitation.failureReason = emailErrReason || 'Email delivery failed';
                }
                else {
                    invitation.failureReason = whatsappErrReason || 'WhatsApp delivery failed';
                }
                if (invitee.invitationStatus === Invitee_1.InvitationStatus.PENDING) {
                    invitee.invitationStatus = Invitee_1.InvitationStatus.FAILED;
                }
            }
            await invitation.save();
            await invitee.save();
            if (invitation.status === Invitation_1.InvitationDeliveryStatus.SENT) {
                await credential_service_1.credentialService.recordIssuance({ invitee, tokenHash, source: 'SEND', actorId: organizerId, actorRole: userRole || 'ORGANIZER', organizerId: event.organizerId }).catch((e) => console.error('Credential history not recorded:', e?.message));
            }
            if (invitation.status === Invitation_1.InvitationDeliveryStatus.SENT && (await eventIsCancelled(eventId))) {
                await cancellationNotice_service_1.cancellationNoticeService.enqueueLateInvitee(eventId, invitee._id).catch((e) => console.error('Late cancellation notice failed:', e?.message));
            }
            const cleanMobile = invitee.mobile ? whatsapp_service_1.whatsappService.normalizePhoneNumber(invitee.mobile) : '';
            const waText = `Dear ${invitee.name},\n\nYou are cordially invited to ${event.title}!\n\n📅 Date: ${eventDate}\n⏰ Time: ${eventTime}\n📍 Venue: ${venue}\n\nView your official Invitation Pass & QR Code here:\n${invitationUrl}\n\nWe look forward to seeing you!`;
            const whatsappWebUrl = cleanMobile ? `https://api.whatsapp.com/send?phone=${cleanMobile}&text=${encodeURIComponent(waText)}` : undefined;
            return {
                inviteeId: invitee._id,
                inviteeName: invitee.name,
                inviteeMobile: invitee.mobile,
                status: invitation.status,
                emailStatus: invitation.emailStatus,
                whatsappStatus: invitation.whatsappStatus,
                whatsappMessageId: invitation.whatsappMessageId,
                failureReason: invitation.failureReason,
                whatsappWebUrl,
            };
        };
        const outcomes = await (0, concurrency_1.mapLimit)(invitees, sendConcurrency(), async (invitee) => {
            const skipped = (failureReason) => ({ inviteeId: invitee._id, inviteeName: invitee.name, inviteeMobile: invitee.mobile, status: 'SKIPPED', failureReason });
            if (alreadySent.has(String(invitee._id)) || invitee.invitationStatus === Invitee_1.InvitationStatus.SENT)
                return skipped(exports.SKIPPED_ALREADY_INVITED);
            // A double click or two tabs sending the same guest: the claim is on the guest's record, so it holds across backend instances
            if (!(await (0, inviteeClaim_1.claimInviteeForIssue)(invitee._id)))
                return skipped(exports.SKIPPED_ALREADY_INVITED);
            try {
                // What was read before the claim may be out of date: another request may have finished delivering in between
                const current = await Invitee_1.Invitee.findById(invitee._id).select('+qrTokenCipher +invitationTokenCipher');
                if (!current)
                    return skipped(exports.SKIPPED_NO_CONTACT);
                if (current.invitationStatus === Invitee_1.InvitationStatus.SENT)
                    return skipped(exports.SKIPPED_ALREADY_INVITED);
                return await deliverToInvitee(current);
            }
            finally {
                await (0, inviteeClaim_1.releaseInviteeClaim)(invitee._id).catch((e) => console.error('Delivery claim release failed:', e?.message));
            }
        });
        results.push(...outcomes);
        const failedCount = results.filter((r) => r.status === 'FAILED').length;
        if (failedCount > 0) {
            const content = {
                type: 'INVITATION',
                title: 'Invitation delivery failed',
                message: `${failedCount} of ${results.length} invitation(s) for "${event.title}" could not be delivered. Open the invitees list to see the reasons and resend.`,
                entityType: 'Event',
                entityId: event._id
            };
            await alert_service_1.alertService.notifyUser(event.organizerId, content);
            await alert_service_1.alertService.notifyAdmins('invitationSendFailed', content);
        }
        return results;
    },
    async resendInvitations(eventId, userOrOrganizerId, invitationIds, channelOverride) {
        const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
        const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
        const userRole = isUserObj ? userOrOrganizerId.role : undefined;
        let event;
        if (userRole === User_1.Role.ADMIN || userRole === 'ADMIN') {
            event = await Event_1.Event.findById(eventId);
        }
        else {
            event = await Event_1.Event.findOne({ _id: eventId, organizerId });
        }
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        // A cancelled or finished event never issues, sends or re-sends an invitation (and so never mints a pass that could be scanned)
        assertEventCanIssue(event);
        // The design follows the organizer's template, or the event's type when none was chosen (see cardTemplates/designs.ts)
        const cardContext = await (0, context_1.loadCardContext)(event);
        const cardDesign = cardContext.cardDesign;
        // the organizer's logo goes at the bottom of each invitation email (read once per send)
        const brand = await organizerBrand(event.organizerId);
        // Resolved once per event (not per invitee) — the same organizer-uploaded photo goes on
        // every invitee's card for this event.
        const eventPhotoBase64 = await (0, resolveImageBase64_1.resolveImageKeyBase64)(event.media?.logoKey);
        const allSessions = await Session_1.Session.find({ eventId });
        const idsArray = Array.isArray(invitationIds) ? invitationIds : typeof invitationIds === "string" ? [invitationIds] : [];
        const validObjectIds = idsArray
            .filter((id) => mongoose_1.default.Types.ObjectId.isValid(id))
            .map((id) => new mongoose_1.default.Types.ObjectId(id));
        if (validObjectIds.length === 0)
            throw new Error('INVALID_INVITATIONS');
        const invitations = await Invitation_1.Invitation.find({ _id: { $in: validObjectIds }, eventId }).populate({ path: 'inviteeId', select: '+qrTokenCipher +invitationTokenCipher' });
        if (invitations.length === 0)
            throw new Error('INVALID_INVITATIONS');
        const results = [];
        const outcomes = await (0, concurrency_1.mapLimit)(invitations, sendConcurrency(), async (invitation) => {
            const invitee = invitation.inviteeId;
            if (invitee && !(await (0, inviteeClaim_1.claimInviteeForIssue)(invitee._id))) {
                return { invitationId: invitation._id, inviteeId: invitee._id, inviteeName: invitee.name, status: 'SKIPPED', failureReason: exports.SKIPPED_IN_PROGRESS };
            }
            try {
                if (!invitee) {
                    invitation.status = Invitation_1.InvitationDeliveryStatus.FAILED;
                    invitation.failureReason = 'INVITEE_DELETED';
                    await invitation.save();
                    return { invitationId: invitation._id, status: 'FAILED', failureReason: 'INVITEE_DELETED' };
                }
                if (await eventIsCancelled(eventId)) {
                    return { invitationId: invitation._id, inviteeId: invitee._id, inviteeName: invitee.name, status: 'SKIPPED', failureReason: exports.SKIPPED_EVENT_CANCELLED };
                }
                // A revoked pass is not re-sent: that would deliver a pass that does not work. Replacing it is a deliberate, recorded action.
                if (invitee.credentialRevokedAt) {
                    return { invitationId: invitation._id, inviteeId: invitee._id, inviteeName: invitee.name, status: 'SKIPPED', failureReason: exports.SKIPPED_PASS_REVOKED };
                }
                const activeChannel = (channelOverride || invitation.channel);
                const use = channelsForInvitee(activeChannel, invitee);
                if (!use.email && !use.whatsapp) {
                    // Nothing usable: the guest's current pass and delivery record stay as they are
                    return { invitationId: invitation._id, inviteeId: invitee._id, inviteeName: invitee.name, status: 'SKIPPED', failureReason: exports.SKIPPED_NO_CONTACT };
                }
                // A re-send mints a new ADMISSION credential (the QR already delivered stops working); the invitation link is unchanged
                const rawToken = (0, invitation_util_1.generateSecureToken)();
                const tokenHash = (0, invitation_util_1.hashToken)(rawToken);
                const invitationToken = (0, credentialTokens_1.planInvitationToken)(invitee);
                const invitationUrl = (0, qrPayload_1.invitationUrlFor)(invitationToken.raw);
                const qrDataUrl = await (0, qr_util_1.generateQRCodeDataURL)((0, qrPayload_1.admissionPayloadFor)(rawToken));
                const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
                const qrBuffer = Buffer.from(base64Data, 'base64');
                const resendInvitation = new Invitation_1.Invitation({
                    eventId,
                    inviteeId: invitee._id,
                    channel: activeChannel,
                    status: Invitation_1.InvitationDeliveryStatus.PENDING,
                    tokenHash
                });
                const shouldSendEmail = use.email;
                const shouldSendWhatsApp = use.whatsapp;
                let emailSuccess = false;
                let whatsappSuccess = false;
                let emailErrReason = '';
                let whatsappErrReason = '';
                // Event/session details for this invitee, rendered in the platform time zone
                const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } = (0, invitationContent_1.buildInvitationContent)(event, allSessions, invitee);
                // Render canonical personalized invitation card PNG
                let cardBuffer;
                try {
                    cardBuffer = await invitationCard_service_1.invitationCardService.generateInvitationCardPNG({
                        invitee: { id: invitee._id.toString(), ...(0, cardInfo_1.cardGuestLines)(invitee, event.cardInfo) },
                        event: {
                            id: event._id.toString(),
                            title: event.title,
                            date: eventDate,
                            dayOfWeek,
                            startTime: eventTime,
                            timeSub: 'ONWARDS',
                            venue,
                            locationSub,
                            photoBase64: eventPhotoBase64,
                            startIso: event.schedule?.start,
                            endIso: event.schedule?.end,
                            categoryName: cardContext.categoryName,
                            subcategoryName: cardContext.subcategoryName,
                            isVirtual: event.format === 'VIRTUAL',
                            description: event.description,
                            organizerName: cardContext.organizerName,
                            contactNumber: event.contactNumber
                        },
                        sessions: assignedSessions,
                        qrDataUrl,
                        invitationUrl: (0, qrPayload_1.admissionPayloadFor)(rawToken), // the card's QR (fallback) is always the admission credential
                        cardDesign,
                        designSpec: cardContext.designSpec,
                        cardDisplay: event.cardDisplay
                    });
                }
                catch (err) {
                    console.error('Failed to generate high-resolution invitation card PNG for resend:', err);
                    cardBuffer = qrBuffer;
                }
                if (shouldSendEmail && !(await eventIsCancelled(eventId))) {
                    try {
                        if (!invitee.email)
                            throw new Error('MISSING_EMAIL');
                        const cid = `invitation-qr-${invitee._id}`;
                        const cardCid = `invitation-card-${invitee._id}`;
                        const htmlContent = buildFormalInvitationEmailHTML({
                            eventTitle: event.title,
                            inviteeName: invitee.name,
                            inviteeEmail: invitee.email,
                            eventDate,
                            eventTime,
                            venue,
                            dietaryPreference: invitee.dietaryPreference,
                            asksDietary: !!event.dietaryPreference?.enabled && Array.isArray(event.dietaryPreference?.options) && event.dietaryPreference.options.length > 0,
                            invitationUrl,
                            cid,
                            cardCid,
                            isReminder: true,
                            organizerLogoCid: brand.logo ? `organizer-logo-${invitee._id}` : undefined,
                            organizerName: brand.name,
                            organizationName: brand.organizationName,
                            startIso: event.schedule?.start,
                            endIso: event.schedule?.end,
                            locationSub,
                            isVirtual: event.format === 'VIRTUAL',
                            description: event.description,
                            contactNumber: event.contactNumber,
                            rsvpBy: event.rsvp?.enabled ? event.rsvp?.acceptanceLastDate : undefined,
                            showQr: event.cardDisplay?.qr !== false,
                        });
                        const attachments = [
                            {
                                filename: 'invitation-card.png',
                                content: cardBuffer,
                                cid: cardCid,
                                contentType: 'image/png'
                            },
                            // the QR goes in only when the email shows it on its own, i.e. there is no card image to carry it (an unused inline image
                            // would appear as a loose attachment in Gmail)
                            ...(event.cardDisplay?.qr !== false && !cardBuffer?.length ? [{
                                    filename: 'invitation-qr.png',
                                    content: qrBuffer,
                                    cid,
                                    contentType: 'image/png'
                                }] : []),
                            ...(brand.logo ? [{ filename: 'organizer-logo', content: brand.logo.content, cid: `organizer-logo-${invitee._id}`, contentType: brand.logo.contentType }] : []),
                            // the details icons, and the LGPSM logo while the organizer has none of their own
                            ...(await (0, emailImages_1.inlineImagesFor)(htmlContent))
                        ];
                        await (0, email_provider_1.sendEmail)(invitee.email, (0, invitationEmail_1.invitationEmailSubject)(event.title, true), htmlContent, attachments);
                        emailSuccess = true;
                        resendInvitation.emailStatus = Invitation_1.InvitationDeliveryStatus.SENT;
                        resendInvitation.emailFailureReason = undefined;
                    }
                    catch (err) {
                        emailSuccess = false;
                        emailErrReason = err.message === 'PROVIDER_NOT_CONFIGURED' ? 'Email provider not configured' : err.message;
                        resendInvitation.emailStatus = Invitation_1.InvitationDeliveryStatus.FAILED;
                        resendInvitation.emailFailureReason = emailErrReason;
                    }
                }
                if (shouldSendWhatsApp && !(await eventIsCancelled(eventId))) {
                    try {
                        if (!invitee.mobile)
                            throw new Error('MISSING_MOBILE');
                        const { messageId } = await whatsapp_service_1.whatsappService.sendInvitationWhatsApp({
                            recipientPhone: invitee.mobile,
                            qrBuffer: cardBuffer,
                            inviteeName: invitee.name,
                            eventTitle: event.title,
                            eventDate,
                            eventTime,
                            venue
                        });
                        whatsappSuccess = true;
                        resendInvitation.whatsappStatus = Invitation_1.InvitationDeliveryStatus.SENT;
                        resendInvitation.whatsappMessageId = messageId;
                        resendInvitation.whatsappFailureReason = undefined;
                    }
                    catch (err) {
                        whatsappSuccess = false;
                        whatsappErrReason = (0, whatsapp_service_1.describeWhatsAppError)(err.message);
                        resendInvitation.whatsappStatus = Invitation_1.InvitationDeliveryStatus.FAILED;
                        resendInvitation.whatsappFailureReason = whatsappErrReason;
                    }
                }
                const anySuccess = (shouldSendEmail && emailSuccess) || (shouldSendWhatsApp && whatsappSuccess);
                if (anySuccess) {
                    resendInvitation.status = Invitation_1.InvitationDeliveryStatus.SENT;
                    resendInvitation.sentAt = new Date();
                    resendInvitation.failureReason = undefined;
                    invitee.qrTokenHash = tokenHash;
                    invitee.qrTokenCipher = (0, tokenCipher_1.encryptToken)(rawToken);
                    if (invitationToken.persist) {
                        invitee.invitationTokenHash = invitationToken.hash;
                        invitee.invitationTokenCipher = invitationToken.cipher;
                    }
                    invitee.invitationStatus = Invitee_1.InvitationStatus.SENT;
                }
                else {
                    resendInvitation.status = Invitation_1.InvitationDeliveryStatus.FAILED;
                    const failures = [];
                    if (shouldSendEmail && emailErrReason)
                        failures.push(`Email: ${emailErrReason}`);
                    if (shouldSendWhatsApp && whatsappErrReason)
                        failures.push(`WhatsApp: ${whatsappErrReason}`);
                    resendInvitation.failureReason = failures.join(' | ') || 'Delivery failed';
                }
                await resendInvitation.save();
                await invitee.save();
                if (resendInvitation.status === Invitation_1.InvitationDeliveryStatus.SENT) {
                    await credential_service_1.credentialService.recordIssuance({ invitee, tokenHash, source: 'RESEND', actorId: organizerId, actorRole: userRole || 'ORGANIZER', organizerId: event.organizerId }).catch((e) => console.error('Credential history not recorded:', e?.message));
                }
                if (resendInvitation.status === Invitation_1.InvitationDeliveryStatus.SENT && (await eventIsCancelled(eventId))) {
                    await cancellationNotice_service_1.cancellationNoticeService.enqueueLateInvitee(eventId, invitee._id).catch((e) => console.error('Late cancellation notice failed:', e?.message));
                }
                const cleanMobile = invitee.mobile ? whatsapp_service_1.whatsappService.normalizePhoneNumber(invitee.mobile) : '';
                const waText = `Dear ${invitee.name},\n\nYou are cordially invited to ${event.title}!\n\n📅 Date: ${eventDate}\n⏰ Time: ${eventTime}\n📍 Venue: ${venue}\n\nView your official Invitation Pass & QR Code here:\n${invitationUrl}\n\nWe look forward to seeing you!`;
                const whatsappWebUrl = cleanMobile ? `https://api.whatsapp.com/send?phone=${cleanMobile}&text=${encodeURIComponent(waText)}` : undefined;
                return {
                    invitationId: resendInvitation._id,
                    inviteeId: invitee._id,
                    inviteeName: invitee.name,
                    inviteeMobile: invitee.mobile,
                    status: resendInvitation.status,
                    emailStatus: resendInvitation.emailStatus,
                    whatsappStatus: resendInvitation.whatsappStatus,
                    whatsappMessageId: resendInvitation.whatsappMessageId,
                    failureReason: resendInvitation.failureReason,
                    whatsappWebUrl,
                };
            }
            finally {
                if (invitee)
                    await (0, inviteeClaim_1.releaseInviteeClaim)(invitee._id).catch((e) => console.error('Delivery claim release failed:', e?.message));
            }
        });
        results.push(...outcomes);
        const failedCount = results.filter((r) => r.status === 'FAILED').length;
        if (failedCount > 0) {
            const content = {
                type: 'INVITATION',
                title: 'Invitation delivery failed',
                message: `${failedCount} of ${results.length} invitation(s) for "${event.title}" could not be delivered. Open the invitees list to see the reasons and resend.`,
                entityType: 'Event',
                entityId: event._id
            };
            await alert_service_1.alertService.notifyUser(event.organizerId, content);
            await alert_service_1.alertService.notifyAdmins('invitationSendFailed', content);
        }
        return results;
    },
    async getInvitations(eventId, userOrOrganizerId, page = 1, limit = 20) {
        const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
        const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
        const userRole = isUserObj ? userOrOrganizerId.role : undefined;
        let event;
        if (userRole === User_1.Role.ADMIN || userRole === 'ADMIN') {
            event = await Event_1.Event.findById(eventId);
        }
        else {
            event = await Event_1.Event.findOne({ _id: eventId, organizerId });
        }
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        const safePage = Math.max(page, 1), safeLimit = Math.min(Math.max(limit, 1), 200);
        const skip = (safePage - 1) * safeLimit;
        const invitations = await Invitation_1.Invitation.find({ eventId })
            .populate('inviteeId', 'name email mobile invitationStatus rsvpStatus')
            .skip(skip)
            .limit(safeLimit)
            .sort({ createdAt: -1 })
            .lean();
        // Strip tokenHash from response for security
        const secureInvitations = invitations.map((inv) => {
            const { tokenHash, ...rest } = inv;
            return rest;
        });
        const total = await Invitation_1.Invitation.countDocuments({ eventId });
        return {
            invitations: secureInvitations,
            total,
            page: safePage,
            totalPages: Math.ceil(total / safeLimit)
        };
    },
    // Hides the event's delivery history. Records are kept: Resend addresses them by id and check-in uses them to
    // tell a superseded QR from an unknown one. Sending or resending to a guest makes that guest's entry visible again.
    async clearHistory(eventId, userOrOrganizerId) {
        const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
        const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
        const userRole = isUserObj ? userOrOrganizerId.role : undefined;
        const event = userRole === User_1.Role.ADMIN || userRole === 'ADMIN'
            ? await Event_1.Event.findById(eventId)
            : await Event_1.Event.findOne({ _id: eventId, organizerId });
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        const result = await Invitation_1.Invitation.updateMany({ eventId, clearedAt: { $exists: false } }, { $set: { clearedAt: new Date() } });
        return { cleared: result.modifiedCount };
    },
    async previewInvitationCard(eventId, userOrOrganizerId, inviteeId) {
        const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
        const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
        const userRole = isUserObj ? userOrOrganizerId.role : undefined;
        let event;
        if (userRole === User_1.Role.ADMIN || userRole === 'ADMIN') {
            event = await Event_1.Event.findById(eventId);
        }
        else {
            event = await Event_1.Event.findOne({ _id: eventId, organizerId });
        }
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        // The sample card (no guest) is the same for everyone who may see this event, so it is rendered once and kept briefly. The key
        // carries the event's last update; the short life covers edits to the template or organization that do not touch the event.
        const sampleKey = !inviteeId ? `${event._id}:${event.updatedAt?.getTime?.() ?? 0}:${event.templateId ?? ''}` : null;
        if (sampleKey) {
            const hit = sampleCards.get(sampleKey);
            if (hit && hit.until > Date.now())
                return { png: hit.png, qr: 'SAMPLE' };
        }
        // The design follows the organizer's template, or the event's type when none was chosen (see cardTemplates/designs.ts)
        const cardContext = await (0, context_1.loadCardContext)(event);
        const cardDesign = cardContext.cardDesign;
        // the organizer's logo goes at the bottom of each invitation email (read once per send)
        const brand = await organizerBrand(event.organizerId);
        // Resolved once per event (not per invitee) — the same organizer-uploaded photo goes on
        // every invitee's card for this event.
        const eventPhotoBase64 = await (0, resolveImageBase64_1.resolveImageKeyBase64)(event.media?.logoKey);
        // Without a specific invitee the preview shows the design's sample guest lines
        let invitee = null;
        if (inviteeId && mongoose_1.default.Types.ObjectId.isValid(inviteeId)) {
            invitee = await Invitee_1.Invitee.findOne({ _id: inviteeId, eventId }).select('+qrTokenCipher');
        }
        const guestLines = (0, cardInfo_1.cardGuestLines)(invitee, event.cardInfo);
        const allSessions = await Session_1.Session.find({ eventId }).sort({ 'schedule.start': 1 }).lean();
        const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } = (0, invitationContent_1.buildInvitationContent)(event, allSessions, invitee);
        // A guest who has been sent an invitation gets their current, check-in-valid QR. Otherwise the
        // card carries a clearly marked sample QR that check-in recognises and rejects.
        const issuedToken = invitee ? currentIssuedToken(invitee) : null;
        const invitationUrl = issuedToken ? (0, qrPayload_1.admissionPayloadFor)(issuedToken) : (0, qrPayload_1.previewSampleUrl)();
        const qrDataUrl = await (0, qr_util_1.generateQRCodeDataURL)(invitationUrl);
        const png = await invitationCard_service_1.invitationCardService.generateInvitationCardPNG({
            invitee: guestLines,
            event: {
                title: event.title,
                date: eventDate,
                dayOfWeek,
                startTime: eventTime,
                timeSub: 'ONWARDS',
                venue,
                locationSub,
                photoBase64: eventPhotoBase64,
                startIso: event.schedule?.start,
                endIso: event.schedule?.end,
                categoryName: cardContext.categoryName,
                subcategoryName: cardContext.subcategoryName,
                isVirtual: event.format === 'VIRTUAL',
                description: event.description,
                organizerName: cardContext.organizerName,
                contactNumber: event.contactNumber
            },
            sessions: assignedSessions,
            qrDataUrl,
            invitationUrl,
            cardDesign,
            designSpec: cardContext.designSpec,
            cardDisplay: event.cardDisplay
        });
        if (sampleKey && !issuedToken) {
            if (sampleCards.size >= 200)
                sampleCards.delete(sampleCards.keys().next().value);
            sampleCards.set(sampleKey, { png, until: Date.now() + 5 * 60 * 1000 });
        }
        return { png, qr: issuedToken ? 'ISSUED' : 'SAMPLE' };
    }
};
function currentIssuedToken(invitee) {
    const token = (0, tokenCipher_1.decryptToken)(invitee.qrTokenCipher);
    return token && invitee.qrTokenHash && (0, invitation_util_1.hashToken)(token) === invitee.qrTokenHash ? token : null;
}
