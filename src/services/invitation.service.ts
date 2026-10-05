import { buildInvitationContent } from '../utils/invitationContent';
import { alertService } from './alert.service';
import mongoose from 'mongoose';
import { Event } from '../models/Event';
import { Invitee, InvitationStatus } from '../models/Invitee';
import { Invitation, DeliveryChannel, InvitationDeliveryStatus } from '../models/Invitation';
import { Session } from '../models/Session';
import { Role } from '../models/User';
import { generateSecureToken, hashToken } from '../utils/invitation.util';
import { generateQRCodeDataURL } from '../utils/qr.util';
import { invitationUrlFor, previewSampleUrl } from '../utils/qrPayload';
import { decryptToken, encryptToken } from '../utils/tokenCipher';
import { sendEmail } from '../utils/email.provider';
import { whatsappService } from './whatsapp.service';
import { invitationCardService } from './invitationCard.service';

function buildFormalInvitationEmailHTML(params: {
  eventTitle: string;
  inviteeName: string;
  eventDate: string;
  eventTime: string;
  venue: string;
  dietaryPreference?: string;
  invitationUrl: string;
  cid: string;
  cardCid?: string;
  isReminder?: boolean;
}): string {
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

export const invitationService = {
  async sendInvitations(eventId: string, userOrOrganizerId: any, inviteeIds: string[], channel: DeliveryChannel) {
    const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
    const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
    const userRole = isUserObj ? userOrOrganizerId.role : undefined;

    let event;
    if (userRole === Role.ADMIN || userRole === 'ADMIN') {
      event = await Event.findById(eventId);
    } else {
      event = await Event.findOne({ _id: eventId, organizerId });
    }
    if (!event) throw new Error('EVENT_NOT_FOUND');

    // Filter unique inviteeIds to prevent duplicate processing in one request
    const idsArray = Array.isArray(inviteeIds) ? inviteeIds : typeof inviteeIds === "string" ? [inviteeIds] : [];
    const validObjectIds = idsArray
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (validObjectIds.length === 0) throw new Error('INVALID_INVITEES');

    const invitees = await Invitee.find({ _id: { $in: validObjectIds }, eventId });
    if (invitees.length === 0) throw new Error('INVALID_INVITEES');

    const results = [];

    const shouldSendEmail = channel === DeliveryChannel.EMAIL || channel === DeliveryChannel.BOTH;
    const shouldSendWhatsApp = channel === DeliveryChannel.WHATSAPP || channel === DeliveryChannel.BOTH;

    // Load all sessions for this event once
    const allSessions = await Session.find({ eventId }).sort({ 'schedule.start': 1 }).lean();

    for (const invitee of invitees) {
      // Core Rule: Generate ONE secure token & ONE QR per event/invitee per send batch
      const rawToken = generateSecureToken();
      const tokenHash = hashToken(rawToken);
      const invitationUrl = invitationUrlFor(rawToken);
      
      const qrDataUrl = await generateQRCodeDataURL(invitationUrl);
      const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
      const qrBuffer = Buffer.from(base64Data, 'base64');

      let invitation = await Invitation.findOne({ eventId, inviteeId: invitee._id });
      if (!invitation) {
        invitation = new Invitation({
          eventId,
          inviteeId: invitee._id,
          channel,
          status: InvitationDeliveryStatus.PENDING,
          tokenHash
        });
      } else {
        invitation.channel = channel;
        invitation.tokenHash = tokenHash;
        invitation.status = InvitationDeliveryStatus.PENDING;
      }

      let emailSuccess = false;
      let whatsappSuccess = false;
      let emailErrReason = '';
      let whatsappErrReason = '';

      // Event/session details for this invitee, rendered in the platform time zone

      const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } =

        buildInvitationContent(event as any, allSessions as any, invitee as any);

      // Render canonical personalized invitation card PNG
      let cardBuffer: Buffer;
      try {
        cardBuffer = await invitationCardService.generateInvitationCardPNG({
          invitee: { id: (invitee._id as any).toString(), name: invitee.name },
          event: {
            id: (event._id as any).toString(),
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
      } catch (err) {
        console.error('Failed to generate high-resolution invitation card PNG:', err);
        cardBuffer = qrBuffer;
      }

      // 1. Process EMAIL if selected
      if (shouldSendEmail) {
        try {
          if (!invitee.email) throw new Error('MISSING_EMAIL');

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

          await sendEmail(invitee.email, `Invitation: ${event.title}`, htmlContent, attachments);
          emailSuccess = true;
          invitation.emailStatus = InvitationDeliveryStatus.SENT;
          invitation.emailFailureReason = undefined;
        } catch (err: any) {
          emailSuccess = false;
          emailErrReason = err.message === 'PROVIDER_NOT_CONFIGURED' ? 'Email provider not configured' : err.message;
          invitation.emailStatus = InvitationDeliveryStatus.FAILED;
          invitation.emailFailureReason = emailErrReason;
        }
      }

      // 2. Process WHATSAPP if selected
      if (shouldSendWhatsApp) {
        try {
          if (!invitee.mobile) throw new Error('MISSING_MOBILE');

          // Pass the high-resolution personalized invitation card PNG buffer to Meta WhatsApp API
          const { messageId } = await whatsappService.sendInvitationWhatsApp({
            recipientPhone: invitee.mobile,
            qrBuffer: cardBuffer,
            inviteeName: invitee.name,
            eventTitle: event.title,
            eventDate,
            eventTime,
            venue
          });

          whatsappSuccess = true;
          invitation.whatsappStatus = InvitationDeliveryStatus.SENT;
          invitation.whatsappMessageId = messageId;
          invitation.whatsappFailureReason = undefined;
        } catch (err: any) {
          whatsappSuccess = false;
          whatsappErrReason = err.message;
          invitation.whatsappStatus = InvitationDeliveryStatus.FAILED;
          invitation.whatsappFailureReason = whatsappErrReason;
        }
      }

      const anySuccess = (shouldSendEmail && emailSuccess) || (shouldSendWhatsApp && whatsappSuccess);

      if (anySuccess) {
        invitation.status = InvitationDeliveryStatus.SENT;
        invitation.sentAt = new Date();
        invitation.failureReason = undefined;

        // Save active token and status on Invitee model
        invitee.qrTokenHash = tokenHash;
        invitee.qrTokenCipher = encryptToken(rawToken);
        invitee.invitationStatus = InvitationStatus.SENT;
      } else {
        invitation.status = InvitationDeliveryStatus.FAILED;
        if (shouldSendEmail && shouldSendWhatsApp) {
          const failures = [];
          if (emailErrReason) failures.push(`Email: ${emailErrReason}`);
          if (whatsappErrReason) failures.push(`WhatsApp: ${whatsappErrReason}`);
          invitation.failureReason = failures.join(' | ') || 'Delivery failed';
        } else if (shouldSendEmail) {
          invitation.failureReason = emailErrReason || 'Email delivery failed';
        } else {
          invitation.failureReason = whatsappErrReason || 'WhatsApp delivery failed';
        }

        if (invitee.invitationStatus === InvitationStatus.PENDING) {
          invitee.invitationStatus = InvitationStatus.FAILED;
        }
      }

      await invitation.save();
      await invitee.save();

      const cleanMobile = invitee.mobile ? whatsappService.normalizePhoneNumber(invitee.mobile) : '';
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

    const failedCount = results.filter((r: any) => r.status === 'FAILED').length;
    if (failedCount > 0) {
      const content = {
        type: 'INVITATION',
        title: 'Invitation delivery failed',
        message: `${failedCount} of ${results.length} invitation(s) for "${event.title}" could not be delivered. Open the invitees list to see the reasons and resend.`,
        entityType: 'Event',
        entityId: event._id
      };
      await alertService.notifyUser(event.organizerId, content);
      await alertService.notifyAdmins('invitationSendFailed', content);
    }
    return results;
  },

  async resendInvitations(eventId: string, userOrOrganizerId: any, invitationIds: string[], channelOverride?: string) {
    const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
    const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
    const userRole = isUserObj ? userOrOrganizerId.role : undefined;

    let event;
    if (userRole === Role.ADMIN || userRole === 'ADMIN') {
      event = await Event.findById(eventId);
    } else {
      event = await Event.findOne({ _id: eventId, organizerId });
    }
    if (!event) throw new Error('EVENT_NOT_FOUND');
    const allSessions = await Session.find({ eventId });

    const idsArray = Array.isArray(invitationIds) ? invitationIds : typeof invitationIds === "string" ? [invitationIds] : [];
    const validObjectIds = idsArray
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (validObjectIds.length === 0) throw new Error('INVALID_INVITATIONS');

    const invitations = await Invitation.find({ _id: { $in: validObjectIds }, eventId }).populate('inviteeId');
    if (invitations.length === 0) throw new Error('INVALID_INVITATIONS');

    const results = [];

    for (const invitation of invitations) {
      const invitee = invitation.inviteeId as any;
      if (!invitee) {
        invitation.status = InvitationDeliveryStatus.FAILED;
        invitation.failureReason = 'INVITEE_DELETED';
        await invitation.save();
        results.push({ invitationId: invitation._id, status: 'FAILED', failureReason: 'INVITEE_DELETED' });
        continue;
      }

      const rawToken = generateSecureToken();
      const tokenHash = hashToken(rawToken);
      const invitationUrl = invitationUrlFor(rawToken);

      const qrDataUrl = await generateQRCodeDataURL(invitationUrl);
      const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
      const qrBuffer = Buffer.from(base64Data, 'base64');

      const activeChannel = (channelOverride || invitation.channel) as DeliveryChannel;

      const resendInvitation = new Invitation({
        eventId,
        inviteeId: invitee._id,
        channel: activeChannel,
        status: InvitationDeliveryStatus.PENDING,
        tokenHash
      });

      const shouldSendEmail = activeChannel === DeliveryChannel.EMAIL || activeChannel === DeliveryChannel.BOTH;
      const shouldSendWhatsApp = activeChannel === DeliveryChannel.WHATSAPP || activeChannel === DeliveryChannel.BOTH;

      let emailSuccess = false;
      let whatsappSuccess = false;
      let emailErrReason = '';
      let whatsappErrReason = '';

      // Event/session details for this invitee, rendered in the platform time zone

      const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } =

        buildInvitationContent(event as any, allSessions as any, invitee as any);

      // Render canonical personalized invitation card PNG
      let cardBuffer: Buffer;
      try {
        cardBuffer = await invitationCardService.generateInvitationCardPNG({
          invitee: { id: (invitee._id as any).toString(), name: invitee.name, companyName: invitee.companyName || invitee.company || '' },
          event: {
            id: (event._id as any).toString(),
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
      } catch (err) {
        console.error('Failed to generate high-resolution invitation card PNG for resend:', err);
        cardBuffer = qrBuffer;
      }

      if (shouldSendEmail) {
        try {
          if (!invitee.email) throw new Error('MISSING_EMAIL');

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

          await sendEmail(invitee.email, `Reminder: ${event.title}`, htmlContent, attachments);
          emailSuccess = true;
          resendInvitation.emailStatus = InvitationDeliveryStatus.SENT;
          resendInvitation.emailFailureReason = undefined;
        } catch (err: any) {
          emailSuccess = false;
          emailErrReason = err.message === 'PROVIDER_NOT_CONFIGURED' ? 'Email provider not configured' : err.message;
          resendInvitation.emailStatus = InvitationDeliveryStatus.FAILED;
          resendInvitation.emailFailureReason = emailErrReason;
        }
      }

      if (shouldSendWhatsApp) {
        try {
          if (!invitee.mobile) throw new Error('MISSING_MOBILE');

          const { messageId } = await whatsappService.sendInvitationWhatsApp({
            recipientPhone: invitee.mobile,
            qrBuffer: cardBuffer,
            inviteeName: invitee.name,
            eventTitle: event.title,
            eventDate,
            eventTime,
            venue
          });

          whatsappSuccess = true;
          resendInvitation.whatsappStatus = InvitationDeliveryStatus.SENT;
          resendInvitation.whatsappMessageId = messageId;
          resendInvitation.whatsappFailureReason = undefined;
        } catch (err: any) {
          whatsappSuccess = false;
          whatsappErrReason = err.message;
          resendInvitation.whatsappStatus = InvitationDeliveryStatus.FAILED;
          resendInvitation.whatsappFailureReason = whatsappErrReason;
        }
      }

      const anySuccess = (shouldSendEmail && emailSuccess) || (shouldSendWhatsApp && whatsappSuccess);

      if (anySuccess) {
        resendInvitation.status = InvitationDeliveryStatus.SENT;
        resendInvitation.sentAt = new Date();
        resendInvitation.failureReason = undefined;

        invitee.qrTokenHash = tokenHash;
        invitee.qrTokenCipher = encryptToken(rawToken);
        invitee.invitationStatus = InvitationStatus.SENT;
      } else {
        resendInvitation.status = InvitationDeliveryStatus.FAILED;
        const failures = [];
        if (shouldSendEmail && emailErrReason) failures.push(`Email: ${emailErrReason}`);
        if (shouldSendWhatsApp && whatsappErrReason) failures.push(`WhatsApp: ${whatsappErrReason}`);
        resendInvitation.failureReason = failures.join(' | ') || 'Delivery failed';
      }

      await resendInvitation.save();
      await invitee.save();
      const cleanMobile = invitee.mobile ? whatsappService.normalizePhoneNumber(invitee.mobile) : '';
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

    const failedCount = results.filter((r: any) => r.status === 'FAILED').length;
    if (failedCount > 0) {
      const content = {
        type: 'INVITATION',
        title: 'Invitation delivery failed',
        message: `${failedCount} of ${results.length} invitation(s) for "${event.title}" could not be delivered. Open the invitees list to see the reasons and resend.`,
        entityType: 'Event',
        entityId: event._id
      };
      await alertService.notifyUser(event.organizerId, content);
      await alertService.notifyAdmins('invitationSendFailed', content);
    }
    return results;
  },

  async getInvitations(eventId: string, userOrOrganizerId: any, page: number = 1, limit: number = 20) {
    const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
    const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
    const userRole = isUserObj ? userOrOrganizerId.role : undefined;

    let event;
    if (userRole === Role.ADMIN || userRole === 'ADMIN') {
      event = await Event.findById(eventId);
    } else {
      event = await Event.findOne({ _id: eventId, organizerId });
    }
    if (!event) throw new Error('EVENT_NOT_FOUND');

    const skip = (page - 1) * limit;
    const invitations = await Invitation.find({ eventId })
      .populate('inviteeId', 'name email mobile invitationStatus rsvpStatus')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 })
      .lean();

    // Strip tokenHash from response for security
    const secureInvitations = invitations.map((inv: any) => {
      const { tokenHash, ...rest } = inv;
      return rest;
    });

    const total = await Invitation.countDocuments({ eventId });

    return {
      invitations: secureInvitations,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  },

  async previewInvitationCard(eventId: string, userOrOrganizerId: any, inviteeId?: string): Promise<{ png: Buffer; qr: "ISSUED" | "SAMPLE" }> {
    const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
    const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
    const userRole = isUserObj ? userOrOrganizerId.role : undefined;

    let event;
    if (userRole === Role.ADMIN || userRole === 'ADMIN') {
      event = await Event.findById(eventId);
    } else {
      event = await Event.findOne({ _id: eventId, organizerId });
    }
    if (!event) throw new Error('EVENT_NOT_FOUND');

    // Without a specific invitee the preview shows a neutral placeholder guest
    let inviteeName = 'Guest Name';
    let inviteeCompanyName = '';
    let invitee: any = null;
    if (inviteeId && mongoose.Types.ObjectId.isValid(inviteeId)) {
      invitee = await Invitee.findOne({ _id: inviteeId, eventId }).select('+qrTokenCipher');
      if (invitee) {
        inviteeName = invitee.name;
        inviteeCompanyName = invitee.companyName || '';
      }
    }

    const allSessions = await Session.find({ eventId }).sort({ 'schedule.start': 1 }).lean();
    const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } =
      buildInvitationContent(event as any, allSessions as any, invitee);

    // A guest who has been sent an invitation gets their current, check-in-valid QR. Otherwise the
    // card carries a clearly marked sample QR that check-in recognises and rejects.
    const issuedToken = invitee ? currentIssuedToken(invitee) : null;
    const invitationUrl = issuedToken ? invitationUrlFor(issuedToken) : previewSampleUrl();
    const qrDataUrl = await generateQRCodeDataURL(invitationUrl);

    const png = await invitationCardService.generateInvitationCardPNG({
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
    return { png, qr: issuedToken ? ('ISSUED' as const) : ('SAMPLE' as const) };
  }
};

function currentIssuedToken(invitee: { qrTokenHash?: string; qrTokenCipher?: string }): string | null {
  const token = decryptToken(invitee.qrTokenCipher);
  return token && invitee.qrTokenHash && hashToken(token) === invitee.qrTokenHash ? token : null;
}

