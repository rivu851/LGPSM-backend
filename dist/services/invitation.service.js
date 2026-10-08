"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.invitationService = void 0;
const invitationContent_1 = require("../utils/invitationContent");
const alert_service_1 = require("./alert.service");
const mongoose_1 = __importDefault(require("mongoose"));
const Event_1 = require("../models/Event");
const Invitee_1 = require("../models/Invitee");
const Invitation_1 = require("../models/Invitation");
const Session_1 = require("../models/Session");
const User_1 = require("../models/User");
const invitation_util_1 = require("../utils/invitation.util");
const qr_util_1 = require("../utils/qr.util");
const qrPayload_1 = require("../utils/qrPayload");
const tokenCipher_1 = require("../utils/tokenCipher");
const email_provider_1 = require("../utils/email.provider");
const whatsapp_service_1 = require("./whatsapp.service");
const invitationCard_service_1 = require("./invitationCard.service");
function buildFormalInvitationEmailHTML(params) {
    const { eventTitle, inviteeName, eventDate, eventTime, venue, dietaryPreference, invitationUrl, cid, cardCid, isReminder } = params;
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${eventTitle}</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #F4F5F8; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout: fixed; background-color: #F4F5F8; padding: 30px 0;">
        <tr>
          <td align="center">
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 650px; background-color: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.08); border: 1px solid #E5E7EB;">
              <!-- Header Bar -->
              <tr>
                <td style="background: linear-gradient(135deg, #FF5B22 0%, #CF5317 100%); padding: 24px 30px; text-align: center;">
                  <h1 style="color: #FFFFFF; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; line-height: 1.3;">
                    ${isReminder ? 'INVITATION REMINDER' : 'OFFICIAL INVITATION'}
                  </h1>
                  <p style="color: rgba(255, 255, 255, 0.9); margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">
                    ${eventTitle}
                  </p>
                </td>
              </tr>

              ${cardCid ? `
              <!-- PERSONALIZED INVITATION CARD EMBED -->
              <tr>
                <td align="center" style="padding: 20px 20px 10px 20px; background-color: #1A1919;">
                  <img src="cid:${cardCid}" alt="Personalized Invitation Card" style="width: 100%; max-width: 600px; height: auto; border-radius: 8px; display: block; box-shadow: 0 4px 20px rgba(0,0,0,0.3);" />
                </td>
              </tr>
              ` : ''}

              <!-- Greeting & Body -->
              <tr>
                <td style="padding: 24px 30px 10px 30px; color: #1F2937;">
                  <p style="font-size: 15px; margin: 0 0 12px 0; color: #111827;">Dear <strong>${inviteeName}</strong>,</p>
                  <p style="font-size: 13px; line-height: 1.6; color: #4B5563; margin: 0;">
                    ${isReminder
        ? `This is a friendly reminder of your upcoming invitation to <strong>${eventTitle}</strong>. We look forward to welcoming you.`
        : `You are cordially invited to attend <strong>${eventTitle}</strong>. Below are your official event details and entry pass.`}
                  </p>
                </td>
              </tr>

              <!-- Event Details Box -->
              <tr>
                <td style="padding: 15px 30px;">
                  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #FFF5F2; border: 1px solid #FFDCD1; border-radius: 10px; padding: 20px;">
                    <tr>
                      <td style="padding-bottom: 10px; font-size: 13px; color: #374151;">
                        <strong style="color: #FF5B22;">Event:</strong> ${eventTitle}
                      </td>
                    </tr>
                    <tr>
                      <td style="padding-bottom: 10px; font-size: 13px; color: #374151;">
                        <strong style="color: #FF5B22;">Date:</strong> ${eventDate}
                      </td>
                    </tr>
                    <tr>
                      <td style="padding-bottom: 10px; font-size: 13px; color: #374151;">
                        <strong style="color: #FF5B22;">Time:</strong> ${eventTime}
                      </td>
                    </tr>
                    <tr>
                      <td style="padding-bottom: ${dietaryPreference ? '10px' : '0px'}; font-size: 13px; color: #374151;">
                        <strong style="color: #FF5B22;">Venue:</strong> ${venue}
                      </td>
                    </tr>
                    ${dietaryPreference ? `
                    <tr>
                      <td style="font-size: 13px; color: #374151;">
                        <strong style="color: #FF5B22;">Dietary Preference:</strong> ${dietaryPreference}
                      </td>
                    </tr>
                    ` : ''}
                  </table>
                </td>
              </tr>

              <!-- Entry Pass QR Code Section -->
              <tr>
                <td align="center" style="padding: 20px 30px 30px 30px;">
                  <div style="background-color: #FFFFFF; border: 2px dashed #E5E7EB; border-radius: 12px; padding: 25px; display: inline-block; max-width: 260px;">
                    <p style="font-size: 12px; font-weight: 700; color: #111827; margin: 0 0 12px 0; text-transform: uppercase;">
                      Official Entry QR Pass
                    </p>
                    <img src="cid:${cid}" alt="Entry Pass QR Code" width="190" height="190" style="display: block; margin: 0 auto; border-radius: 6px; border: 1px solid #F3F4F6;" />
                    <p style="font-size: 11px; color: #6B7280; margin: 12px 0 0 0; line-height: 1.4;">
                      Please present this QR code at the check-in desk for entry validation.
                    </p>
                  </div>

                  <!-- Online Pass Button -->
                  <div style="margin-top: 25px;">
                    <a href="${invitationUrl}" target="_blank" style="background-color: #FF5B22; color: #FFFFFF; text-decoration: none; padding: 12px 28px; font-size: 13px; font-weight: 700; border-radius: 6px; display: inline-block;">
                      Access Digital Pass
                    </a>
                  </div>
                </td>
              </tr>

              <!-- Footer Section -->
              <tr>
                <td style="background-color: #F9FAFB; padding: 20px 30px; text-align: center; border-top: 1px solid #E5E7EB; font-size: 11px; color: #9CA3AF;">
                  <p style="margin: 0 0 4px 0;">Organized via <strong>LGPSM Platform</strong></p>
                  <p style="margin: 0;">If you have any questions, please contact the event organizer.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}
exports.invitationService = {
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
        // Filter unique inviteeIds to prevent duplicate processing in one request
        const idsArray = Array.isArray(inviteeIds) ? inviteeIds : typeof inviteeIds === "string" ? [inviteeIds] : [];
        const validObjectIds = idsArray
            .filter((id) => mongoose_1.default.Types.ObjectId.isValid(id))
            .map((id) => new mongoose_1.default.Types.ObjectId(id));
        if (validObjectIds.length === 0)
            throw new Error('INVALID_INVITEES');
        const invitees = await Invitee_1.Invitee.find({ _id: { $in: validObjectIds }, eventId });
        if (invitees.length === 0)
            throw new Error('INVALID_INVITEES');
        const results = [];
        const shouldSendEmail = channel === Invitation_1.DeliveryChannel.EMAIL || channel === Invitation_1.DeliveryChannel.BOTH;
        const shouldSendWhatsApp = channel === Invitation_1.DeliveryChannel.WHATSAPP || channel === Invitation_1.DeliveryChannel.BOTH;
        // Load all sessions for this event once
        const allSessions = await Session_1.Session.find({ eventId }).sort({ 'schedule.start': 1 }).lean();
        for (const invitee of invitees) {
            // Core Rule: Generate ONE secure token & ONE QR per event/invitee per send batch
            const rawToken = (0, invitation_util_1.generateSecureToken)();
            const tokenHash = (0, invitation_util_1.hashToken)(rawToken);
            const invitationUrl = (0, qrPayload_1.invitationUrlFor)(rawToken);
            const qrDataUrl = await (0, qr_util_1.generateQRCodeDataURL)(invitationUrl);
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
                    invitee: { id: invitee._id.toString(), name: invitee.name },
                    event: {
                        id: event._id.toString(),
                        title: event.title,
                        date: eventDate,
                        dayOfWeek,
                        startTime: eventTime,
                        timeSub: 'ONWARDS',
                        venue,
                        locationSub
                    },
                    sessions: assignedSessions,
                    qrDataUrl,
                    invitationUrl
                });
            }
            catch (err) {
                console.error('Failed to generate high-resolution invitation card PNG:', err);
                cardBuffer = qrBuffer;
            }
            // 1. Process EMAIL if selected
            if (shouldSendEmail) {
                try {
                    if (!invitee.email)
                        throw new Error('MISSING_EMAIL');
                    const cid = `invitation-qr-${invitee._id}`;
                    const cardCid = `invitation-card-${invitee._id}`;
                    const htmlContent = buildFormalInvitationEmailHTML({
                        eventTitle: event.title,
                        inviteeName: invitee.name,
                        eventDate,
                        eventTime,
                        venue,
                        dietaryPreference: invitee.dietaryPreference,
                        invitationUrl,
                        cid,
                        cardCid,
                        isReminder: false,
                    });
                    const attachments = [
                        {
                            filename: 'invitation-card.png',
                            content: cardBuffer,
                            cid: cardCid,
                            contentType: 'image/png'
                        },
                        {
                            filename: 'invitation-qr.png',
                            content: qrBuffer,
                            cid,
                            contentType: 'image/png'
                        }
                    ];
                    await (0, email_provider_1.sendEmail)(invitee.email, `Invitation: ${event.title}`, htmlContent, attachments);
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
            if (shouldSendWhatsApp) {
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
                    whatsappErrReason = err.message;
                    invitation.whatsappStatus = Invitation_1.InvitationDeliveryStatus.FAILED;
                    invitation.whatsappFailureReason = whatsappErrReason;
                }
            }
            const anySuccess = (shouldSendEmail && emailSuccess) || (shouldSendWhatsApp && whatsappSuccess);
            if (anySuccess) {
                invitation.status = Invitation_1.InvitationDeliveryStatus.SENT;
                invitation.sentAt = new Date();
                invitation.failureReason = undefined;
                // Save active token and status on Invitee model
                invitee.qrTokenHash = tokenHash;
                invitee.qrTokenCipher = (0, tokenCipher_1.encryptToken)(rawToken);
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
            const cleanMobile = invitee.mobile ? whatsapp_service_1.whatsappService.normalizePhoneNumber(invitee.mobile) : '';
            const waText = `Dear ${invitee.name},\n\nYou are cordially invited to ${event.title}!\n\n📅 Date: ${eventDate}\n⏰ Time: ${eventTime}\n📍 Venue: ${venue}\n\nView your official Invitation Pass & QR Code here:\n${invitationUrl}\n\nWe look forward to seeing you!`;
            const whatsappWebUrl = cleanMobile ? `https://api.whatsapp.com/send?phone=${cleanMobile}&text=${encodeURIComponent(waText)}` : undefined;
            results.push({
                inviteeId: invitee._id,
                inviteeName: invitee.name,
                inviteeMobile: invitee.mobile,
                status: invitation.status,
                emailStatus: invitation.emailStatus,
                whatsappStatus: invitation.whatsappStatus,
                whatsappMessageId: invitation.whatsappMessageId,
                failureReason: invitation.failureReason,
                whatsappWebUrl,
            });
        }
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
        const allSessions = await Session_1.Session.find({ eventId });
        const idsArray = Array.isArray(invitationIds) ? invitationIds : typeof invitationIds === "string" ? [invitationIds] : [];
        const validObjectIds = idsArray
            .filter((id) => mongoose_1.default.Types.ObjectId.isValid(id))
            .map((id) => new mongoose_1.default.Types.ObjectId(id));
        if (validObjectIds.length === 0)
            throw new Error('INVALID_INVITATIONS');
        const invitations = await Invitation_1.Invitation.find({ _id: { $in: validObjectIds }, eventId }).populate('inviteeId');
        if (invitations.length === 0)
            throw new Error('INVALID_INVITATIONS');
        const results = [];
        for (const invitation of invitations) {
            const invitee = invitation.inviteeId;
            if (!invitee) {
                invitation.status = Invitation_1.InvitationDeliveryStatus.FAILED;
                invitation.failureReason = 'INVITEE_DELETED';
                await invitation.save();
                results.push({ invitationId: invitation._id, status: 'FAILED', failureReason: 'INVITEE_DELETED' });
                continue;
            }
            const rawToken = (0, invitation_util_1.generateSecureToken)();
            const tokenHash = (0, invitation_util_1.hashToken)(rawToken);
            const invitationUrl = (0, qrPayload_1.invitationUrlFor)(rawToken);
            const qrDataUrl = await (0, qr_util_1.generateQRCodeDataURL)(invitationUrl);
            const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
            const qrBuffer = Buffer.from(base64Data, 'base64');
            const activeChannel = (channelOverride || invitation.channel);
            const resendInvitation = new Invitation_1.Invitation({
                eventId,
                inviteeId: invitee._id,
                channel: activeChannel,
                status: Invitation_1.InvitationDeliveryStatus.PENDING,
                tokenHash
            });
            const shouldSendEmail = activeChannel === Invitation_1.DeliveryChannel.EMAIL || activeChannel === Invitation_1.DeliveryChannel.BOTH;
            const shouldSendWhatsApp = activeChannel === Invitation_1.DeliveryChannel.WHATSAPP || activeChannel === Invitation_1.DeliveryChannel.BOTH;
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
                    invitee: { id: invitee._id.toString(), name: invitee.name, companyName: invitee.companyName || invitee.company || '' },
                    event: {
                        id: event._id.toString(),
                        title: event.title,
                        date: eventDate,
                        dayOfWeek,
                        startTime: eventTime,
                        timeSub: 'ONWARDS',
                        venue,
                        locationSub
                    },
                    sessions: assignedSessions,
                    qrDataUrl,
                    invitationUrl
                });
            }
            catch (err) {
                console.error('Failed to generate high-resolution invitation card PNG for resend:', err);
                cardBuffer = qrBuffer;
            }
            if (shouldSendEmail) {
                try {
                    if (!invitee.email)
                        throw new Error('MISSING_EMAIL');
                    const cid = `invitation-qr-${invitee._id}`;
                    const cardCid = `invitation-card-${invitee._id}`;
                    const htmlContent = buildFormalInvitationEmailHTML({
                        eventTitle: event.title,
                        inviteeName: invitee.name,
                        eventDate,
                        eventTime,
                        venue,
                        dietaryPreference: invitee.dietaryPreference,
                        invitationUrl,
                        cid,
                        cardCid,
                        isReminder: true,
                    });
                    const attachments = [
                        {
                            filename: 'invitation-card.png',
                            content: cardBuffer,
                            cid: cardCid,
                            contentType: 'image/png'
                        },
                        {
                            filename: 'invitation-qr.png',
                            content: qrBuffer,
                            cid,
                            contentType: 'image/png'
                        }
                    ];
                    await (0, email_provider_1.sendEmail)(invitee.email, `Reminder: ${event.title}`, htmlContent, attachments);
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
            if (shouldSendWhatsApp) {
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
                    whatsappErrReason = err.message;
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
            const cleanMobile = invitee.mobile ? whatsapp_service_1.whatsappService.normalizePhoneNumber(invitee.mobile) : '';
            const waText = `Dear ${invitee.name},\n\nYou are cordially invited to ${event.title}!\n\n📅 Date: ${eventDate}\n⏰ Time: ${eventTime}\n📍 Venue: ${venue}\n\nView your official Invitation Pass & QR Code here:\n${invitationUrl}\n\nWe look forward to seeing you!`;
            const whatsappWebUrl = cleanMobile ? `https://api.whatsapp.com/send?phone=${cleanMobile}&text=${encodeURIComponent(waText)}` : undefined;
            results.push({
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
            });
        }
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
        const skip = (page - 1) * limit;
        const invitations = await Invitation_1.Invitation.find({ eventId })
            .populate('inviteeId', 'name email mobile invitationStatus rsvpStatus')
            .skip(skip)
            .limit(limit)
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
            page,
            totalPages: Math.ceil(total / limit)
        };
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
        // Without a specific invitee the preview shows a neutral placeholder guest
        let inviteeName = 'Guest Name';
        let inviteeCompanyName = '';
        let invitee = null;
        if (inviteeId && mongoose_1.default.Types.ObjectId.isValid(inviteeId)) {
            invitee = await Invitee_1.Invitee.findOne({ _id: inviteeId, eventId }).select('+qrTokenCipher');
            if (invitee) {
                inviteeName = invitee.name;
                inviteeCompanyName = invitee.companyName || '';
            }
        }
        const allSessions = await Session_1.Session.find({ eventId }).sort({ 'schedule.start': 1 }).lean();
        const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } = (0, invitationContent_1.buildInvitationContent)(event, allSessions, invitee);
        // A guest who has been sent an invitation gets their current, check-in-valid QR. Otherwise the
        // card carries a clearly marked sample QR that check-in recognises and rejects.
        const issuedToken = invitee ? currentIssuedToken(invitee) : null;
        const invitationUrl = issuedToken ? (0, qrPayload_1.invitationUrlFor)(issuedToken) : (0, qrPayload_1.previewSampleUrl)();
        const qrDataUrl = await (0, qr_util_1.generateQRCodeDataURL)(invitationUrl);
        const png = await invitationCard_service_1.invitationCardService.generateInvitationCardPNG({
            invitee: { name: inviteeName, companyName: inviteeCompanyName },
            event: {
                title: event.title,
                date: eventDate,
                dayOfWeek,
                startTime: eventTime,
                timeSub: 'ONWARDS',
                venue,
                locationSub
            },
            sessions: assignedSessions,
            qrDataUrl,
            invitationUrl
        });
        return { png, qr: issuedToken ? 'ISSUED' : 'SAMPLE' };
    }
};
function currentIssuedToken(invitee) {
    const token = (0, tokenCipher_1.decryptToken)(invitee.qrTokenCipher);
    return token && invitee.qrTokenHash && (0, invitation_util_1.hashToken)(token) === invitee.qrTokenHash ? token : null;
}
