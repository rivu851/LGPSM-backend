import QRCode from 'qrcode';
import { buildInvitationContent } from '../utils/invitationContent';
import { alertService } from './alert.service';
import mongoose from 'mongoose';
import { Event, EventStatus } from '../models/Event';
import { cancellationNoticeService } from './cancellationNotice.service';
import { credentialService } from './credential.service';
import { CredentialEvent } from '../models/CredentialEvent';
import { Invitee, InvitationStatus } from '../models/Invitee';
import { Invitation, DeliveryChannel, InvitationDeliveryStatus } from '../models/Invitation';
import { Session } from '../models/Session';
import { Role, User } from '../models/User';
import { generateSecureToken, hashToken } from '../utils/invitation.util';
import { generateQRCodeDataURL } from '../utils/qr.util';
import { invitationUrlFor, previewSampleUrl, admissionPayloadFor } from '../utils/qrPayload';
import { invitationLookup, planInvitationToken, readAdmissionToken } from '../utils/credentialTokens';
import { decryptToken, encryptToken } from '../utils/tokenCipher';
import { sendEmail } from '../utils/email.provider';
import { whatsappService, describeWhatsAppError } from './whatsapp.service';
import { invitationCardService } from './invitationCard.service';
import { mapLimit } from '../utils/concurrency';
import { loadCardContext } from './cardTemplates/context';
import { cardGuestLines } from '../utils/cardInfo';
import { resolveImageKeyBase64 } from '../utils/resolveImageBase64';
import { escapeHtml } from '../utils/html';
import { inlineImagesFor } from './email/emailImages';
import { buildInvitationEmail, invitationEmailSubject } from './email/invitationEmail';
import { claimInviteeForIssue, releaseInviteeClaim } from '../utils/inviteeClaim';
import { admissionState, effectiveAdmission } from '../utils/admissionWindow';

// the platform charges in rupees (see constants/currency.ts)
const PLATFORM_CURRENCY_SYMBOL = '₹';

export function buildFormalInvitationEmailHTML(params: {
  eventTitle: string;
  inviteeName: string;
  inviteeEmail?: string;
  eventDate?: string;
  eventTime?: string;
  venue: string;
  dietaryPreference?: string;
  asksDietary?: boolean;
  invitationUrl: string;
  cid: string;
  cardCid?: string;
  isReminder?: boolean;
  /** The organizer's logo (attached inline) and organisation name */
  organizerLogoCid?: string;
  organizerName?: string;
  organizationName?: string;
  startIso?: string | Date | null;
  endIso?: string | Date | null;
  locationSub?: string;
  isVirtual?: boolean;
  description?: string;
  contactNumber?: string;
  rsvpBy?: string | Date | null;
  /** false when the cards are printed without a QR: the email has none either */
  showQr?: boolean;
  sessions?: { name: string; startTime?: string; endTime?: string }[];
}): string {
  // The letter itself lives in services/email/invitationEmail.ts (one template for invitations and reminders)
  return buildInvitationEmail({ ...params, qrCid: params.cid });
}

// Guests in one batch are prepared a few at a time: each one is mostly waiting on image rendering and the mail /
// WhatsApp providers, so a small amount of overlap cuts a big batch's time without flooding either provider.
const sendConcurrency = () => Math.min(Math.max(parseInt(process.env.INVITATION_SEND_CONCURRENCY || '3', 10) || 3, 1), 8);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SKIPPED_NO_CONTACT = 'No email address or WhatsApp number';
export const SKIPPED_ALREADY_INVITED = 'Already invited';
export const SKIPPED_EVENT_CANCELLED = 'The event was cancelled';
export const SKIPPED_PASS_REVOKED = 'Pass revoked: use Replace Access Pass';

export const SKIPPED_IN_PROGRESS = 'A delivery to this guest is already in progress';

/** No pass is issued for an event that is over: it could not be used, and it is a message about the past. */
function assertEventCanIssue(event: any) {
  if (event.status === EventStatus.CANCELLED) throw new Error('EVENT_CANCELLED');
  const window = effectiveAdmission(event);
  if (event.status === EventStatus.COMPLETED || (window && admissionState(window, new Date()) === 'CLOSED')) throw new Error('EVENT_ENDED');
}

/** Read fresh on every use: a cancellation can land while a long send is running. */
const eventIsCancelled = async (eventId: unknown) => !!(await Event.exists({ _id: eventId as any, status: EventStatus.CANCELLED }));

/**
 * Channels to attempt for one guest. EMAIL or WHATSAPP is an explicit request, so a missing contact is a real
 * failure. BOTH ("All") uses whichever of the guest's contacts are usable; a guest with neither is skipped before
 * anything is changed (no new token, invitation status untouched).
 */
export function channelsForInvitee(channel: DeliveryChannel, invitee: { email?: string; mobile?: string }) {
  if (channel !== DeliveryChannel.BOTH) {
    return { email: channel === DeliveryChannel.EMAIL, whatsapp: channel === DeliveryChannel.WHATSAPP };
  }
  return {
    email: !!invitee.email && EMAIL_PATTERN.test(invitee.email.trim()),
    whatsapp: whatsappService.normalizePhoneNumber(invitee.mobile).length >= 10,
  };
}

/** The organizer's logo for the bottom of invitation emails (null when none was uploaded or it cannot be read) */
async function organizerBrand(organizerId: unknown): Promise<{ name?: string; organizationName?: string; logo: { content: Buffer; contentType: string } | null }> {
  if (!organizerId) return { logo: null };
  const organizer: any = await User.findById(organizerId as never).select('fullName profile.organizationName profile.logoKey').lean();
  const organizationName = organizer?.profile?.organizationName?.trim() || undefined; // only when the organizer has set one
  const name = organizationName || organizer?.fullName?.trim() || undefined;
  const dataUrl = await resolveImageKeyBase64(organizer?.profile?.logoKey).catch(() => '');
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  return { name, organizationName, logo: match ? { contentType: match[1], content: Buffer.from(match[2], 'base64') } : null };
}

// Rendered sample cards by event, oldest dropped first (see previewInvitationCard)
const sampleCards = new Map<string, { png: Buffer; until: number }>();

export const invitationService = {
  async publicInvitationCard(rawToken: string): Promise<Buffer> {
    const { event, invitee, admissionToken } = await this.publicPass(rawToken);
    return this.renderPassCard(event, invitee, admissionToken);
  },

  /**
   * The guest's entry QR on its own. Shown on the invitation page when the organizer chose not to print the QR on the card
   * ("Select data to show on card"), so the guest still has a pass to show at the door. Same checks and same credential as the card.
   */
  async publicInvitationQr(rawToken: string): Promise<Buffer> {
    const { admissionToken } = await this.publicPass(rawToken);
    return QRCode.toBuffer(admissionPayloadFor(admissionToken), { errorCorrectionLevel: 'H', margin: 4, width: 640 });
  },

  /** The guest behind an invitation link, their event, and their current admission credential; refused like the card is */
  async publicPass(rawToken: string): Promise<{ event: any; invitee: any; admissionToken: string }> {
    if (!rawToken || typeof rawToken !== 'string') throw new Error('INVALID_TOKEN');
    // The link finds the guest; the pass drawn is their CURRENT admission credential, whichever pass the link was first sent with
    const invitee = await Invitee.findOne(invitationLookup(hashToken(rawToken))).select('+qrTokenCipher');
    if (!invitee) {
      // an address that carried an old admission credential (links sent before the two secrets were separated): say so
      if (await credentialService.isSupersededToken(hashToken(rawToken))) throw new Error('CREDENTIAL_REPLACED');
      throw new Error('INVITATION_NOT_FOUND');
    }
    const event = await Event.findById(invitee.eventId);
    if (!event) throw new Error('INVITATION_NOT_FOUND');
    // The page shows a notice instead; a cancelled event's pass is never drawn (and would be refused at the door anyway)
    if (event.status === EventStatus.CANCELLED) throw new Error('EVENT_CANCELLED');
    // A revoked pass is not drawn either: the page explains instead
    if ((invitee as any).credentialRevokedAt) throw new Error('CREDENTIAL_REVOKED');

    // a guest from before the two secrets were separated, whose pass was stored without a recoverable copy: the link token IS their pass
    const admissionToken = readAdmissionToken(invitee as any) ?? (hashToken(rawToken) === (invitee as any).qrTokenHash ? rawToken : null);
    if (!admissionToken) throw new Error('INVITATION_NOT_FOUND');
    return { event, invitee, admissionToken };
  },

  /** Draws the guest's card with the QR for the ADMISSION credential `rawToken`. Used for the public card and for replacement notices. */
  async renderPassCard(event: any, invitee: any, rawToken: string): Promise<Buffer> {
    const cardContext = await loadCardContext(event);
    const eventPhotoBase64 = await resolveImageKeyBase64((event as any).media?.logoKey);
    const guestLines = cardGuestLines(invitee, (event as any).cardInfo, (event as any).cardDisplay);
    const allSessions = await Session.find({ eventId: event._id }).sort({ 'schedule.start': 1 }).lean();
    const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } =
      buildInvitationContent(event as any, allSessions as any, invitee);
    const invitationUrl = admissionPayloadFor(rawToken); // the QR carries the admission credential, nothing else
    const qrDataUrl = await generateQRCodeDataURL(invitationUrl);

    return invitationCardService.generateInvitationCardPNG({
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
        isVirtual: (event as any).format === 'VIRTUAL',
        description: (event as any).description,
        organizerName: cardContext.organizerName,
        contactNumber: (event as any).contactNumber
      },
      sessions: assignedSessions,
      qrDataUrl,
      invitationUrl,
      cardDesign: cardContext.cardDesign,
      designSpec: cardContext.designSpec,
      cardDisplay: (event as any).cardDisplay
    });
  },

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
    // A cancelled or finished event never issues, sends or re-sends an invitation (and so never mints a pass that could be scanned)
    assertEventCanIssue(event);

    // The design follows the organizer's template, or the event's type when none was chosen (see cardTemplates/designs.ts)
    const cardContext = await loadCardContext(event);
    const cardDesign = cardContext.cardDesign;
    // the organizer's logo goes at the bottom of each invitation email (read once per send)
    const brand = await organizerBrand(event.organizerId);
    // Resolved once per event (not per invitee) — the same organizer-uploaded photo goes on
    // every invitee's card for this event.
    const eventPhotoBase64 = await resolveImageKeyBase64((event as any).media?.logoKey);

    // Filter unique inviteeIds to prevent duplicate processing in one request
    const idsArray = Array.isArray(inviteeIds) ? inviteeIds : typeof inviteeIds === "string" ? [inviteeIds] : [];
    const validObjectIds = idsArray
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (validObjectIds.length === 0) throw new Error('INVALID_INVITEES');

    const invitees = await Invitee.find({ _id: { $in: validObjectIds }, eventId }).select('+qrTokenCipher +invitationTokenCipher');
    if (invitees.length === 0) throw new Error('INVALID_INVITEES');

    const results = [];

    // Load all sessions for this event once
    const allSessions = await Session.find({ eventId }).sort({ 'schedule.start': 1 }).lean();

    // Send is for guests who have not been invited yet (e.g. ones added after the first batch). Anyone already
    // sent is skipped untouched: no new token (which would invalidate the QR they already hold) and no second
    // message. Re-delivery is the explicit Resend action.
    const alreadySent = new Set(
      (await Invitation.find({ eventId, inviteeId: { $in: invitees.map((i) => i._id) }, status: InvitationDeliveryStatus.SENT }).select('inviteeId').lean())
        .map((i: any) => String(i.inviteeId))
    );

    const deliverToInvitee = async (invitee: any): Promise<any> => {
      // A send that was already running when the event was cancelled stops here, before any token or provider call
      if (await eventIsCancelled(eventId)) {
        return { inviteeId: invitee._id, inviteeName: invitee.name, inviteeMobile: invitee.mobile, status: 'SKIPPED', failureReason: SKIPPED_EVENT_CANCELLED } as any;
      }
      const use = channelsForInvitee(channel, invitee);
      if (!use.email && !use.whatsapp) {
        return { inviteeId: invitee._id, inviteeName: invitee.name, inviteeMobile: invitee.mobile, status: 'SKIPPED', failureReason: SKIPPED_NO_CONTACT } as any;
      }
      const shouldSendEmail = use.email;
      const shouldSendWhatsApp = use.whatsapp;
      // Two separate secrets: a new ADMISSION credential (the QR) and the guest's stable INVITATION token (the link)
      const rawToken = generateSecureToken();
      const tokenHash = hashToken(rawToken);
      const invitationToken = planInvitationToken(invitee);
      const invitationUrl = invitationUrlFor(invitationToken.raw);

      const qrDataUrl = await generateQRCodeDataURL(admissionPayloadFor(rawToken));
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
        invitation.clearedAt = undefined; // a fresh delivery belongs in the visible history again
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
          invitee: { id: (invitee._id as any).toString(), ...cardGuestLines(invitee, (event as any).cardInfo, (event as any).cardDisplay) },
          event: {
            id: (event._id as any).toString(),
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
            isVirtual: (event as any).format === 'VIRTUAL',
            description: (event as any).description,
            organizerName: cardContext.organizerName,
            contactNumber: (event as any).contactNumber
          },
          sessions: assignedSessions,
          qrDataUrl,
          invitationUrl: admissionPayloadFor(rawToken), // the card's QR (fallback) is always the admission credential
          cardDesign,
          designSpec: cardContext.designSpec,
          cardDisplay: (event as any).cardDisplay
        });
      } catch (err) {
        console.error('Failed to generate high-resolution invitation card PNG:', err);
        cardBuffer = qrBuffer;
      }

      // 1. Process EMAIL if selected
      if (shouldSendEmail && !(await eventIsCancelled(eventId))) {
        try {
          if (!invitee.email) throw new Error('MISSING_EMAIL');

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
            asksDietary: !!(event as any).dietaryPreference?.enabled && Array.isArray((event as any).dietaryPreference?.options) && (event as any).dietaryPreference.options.length > 0,
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
            isVirtual: (event as any).format === 'VIRTUAL',
            description: (event as any).description,
            contactNumber: (event as any).contactNumber,
            rsvpBy: (event as any).rsvp?.enabled ? (event as any).rsvp?.acceptanceLastDate : undefined,
            showQr: (event as any).cardDisplay?.qr !== false,
            sessions: assignedSessions,
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
            ...((event as any).cardDisplay?.qr !== false && !cardBuffer?.length ? [{
              filename: 'invitation-qr.png',
              content: qrBuffer,
              cid,
              contentType: 'image/png'
            }] : []),
            ...(brand.logo ? [{ filename: 'organizer-logo', content: brand.logo.content, cid: `organizer-logo-${invitee._id}`, contentType: brand.logo.contentType }] : []),
            // the details icons, and the LGPSM logo while the organizer has none of their own
            ...(await inlineImagesFor(htmlContent))
          ];

          await sendEmail(invitee.email, invitationEmailSubject(event.title), htmlContent, attachments);
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
      if (shouldSendWhatsApp && !(await eventIsCancelled(eventId))) {
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
          whatsappErrReason = describeWhatsAppError(err.message);
          invitation.whatsappStatus = InvitationDeliveryStatus.FAILED;
          invitation.whatsappFailureReason = whatsappErrReason;
        }
      }

      const anySuccess = (shouldSendEmail && emailSuccess) || (shouldSendWhatsApp && whatsappSuccess);

      if (anySuccess) {
        invitation.status = InvitationDeliveryStatus.SENT;
        invitation.sentAt = new Date();
        invitation.failureReason = undefined;

        // Save the active admission credential and the invitation token, and the status, on the guest
        invitee.qrTokenHash = tokenHash;
        invitee.qrTokenCipher = encryptToken(rawToken);
        if (invitationToken.persist) { invitee.invitationTokenHash = invitationToken.hash; invitee.invitationTokenCipher = invitationToken.cipher; }
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
      if (invitation.status === InvitationDeliveryStatus.SENT) {
        await credentialService.recordIssuance({ invitee, tokenHash, source: 'SEND', actorId: organizerId, actorRole: userRole || 'ORGANIZER', organizerId: (event as any).organizerId }).catch((e) => console.error('Credential history not recorded:', e?.message));
      }
      if (invitation.status === InvitationDeliveryStatus.SENT && (await eventIsCancelled(eventId))) {
        await cancellationNoticeService.enqueueLateInvitee(eventId, invitee._id).catch((e) => console.error('Late cancellation notice failed:', e?.message));
      }

      const cleanMobile = invitee.mobile ? whatsappService.normalizePhoneNumber(invitee.mobile) : '';
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

    const outcomes = await mapLimit(invitees, sendConcurrency(), async (invitee) => {
      const skipped = (failureReason: string) => ({ inviteeId: invitee._id, inviteeName: invitee.name, inviteeMobile: invitee.mobile, status: 'SKIPPED', failureReason }) as any;
      if (alreadySent.has(String(invitee._id)) || invitee.invitationStatus === InvitationStatus.SENT) return skipped(SKIPPED_ALREADY_INVITED);
      // A double click or two tabs sending the same guest: the claim is on the guest's record, so it holds across backend instances
      if (!(await claimInviteeForIssue(invitee._id))) return skipped(SKIPPED_ALREADY_INVITED);
      try {
        // What was read before the claim may be out of date: another request may have finished delivering in between
        const current: any = await Invitee.findById(invitee._id).select('+qrTokenCipher +invitationTokenCipher');
        if (!current) return skipped(SKIPPED_NO_CONTACT);
        if (current.invitationStatus === InvitationStatus.SENT) return skipped(SKIPPED_ALREADY_INVITED);
        return await deliverToInvitee(current);
      } finally {
        await releaseInviteeClaim(invitee._id).catch((e) => console.error('Delivery claim release failed:', e?.message));
      }
    });
    results.push(...outcomes);

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
    // the administrators hear what was sent, for whom, and what it comes to at the event's locked rate
    const sentCount = results.filter((r: any) => r.status === 'SENT').length;
    if (sentCount > 0) {
      const rate = Number((event as any).pricing?.ratePerInvitee);
      const organizer: any = await User.findById(event.organizerId).select('fullName profile.organizationName').lean();
      const who = organizer?.profile?.organizationName || organizer?.fullName || 'An organizer';
      const charge = Number.isFinite(rate) && rate > 0 ? ` At ${PLATFORM_CURRENCY_SYMBOL}${rate} per invitee that is ${PLATFORM_CURRENCY_SYMBOL}${(rate * sentCount).toLocaleString('en-IN')}.` : '';
      await alertService.notifyAdmins('invitationsSent', {
        type: 'INVITATION',
        title: 'Invitations sent',
        message: `${who} sent ${sentCount} invitation${sentCount === 1 ? '' : 's'} for "${event.title}".${charge}`,
        entityType: 'Event',
        entityId: event._id
      }, { email: false });
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
    // A cancelled or finished event never issues, sends or re-sends an invitation (and so never mints a pass that could be scanned)
    assertEventCanIssue(event);
    // The design follows the organizer's template, or the event's type when none was chosen (see cardTemplates/designs.ts)
    const cardContext = await loadCardContext(event);
    const cardDesign = cardContext.cardDesign;
    // the organizer's logo goes at the bottom of each invitation email (read once per send)
    const brand = await organizerBrand(event.organizerId);
    // Resolved once per event (not per invitee) — the same organizer-uploaded photo goes on
    // every invitee's card for this event.
    const eventPhotoBase64 = await resolveImageKeyBase64((event as any).media?.logoKey);
    const allSessions = await Session.find({ eventId });

    const idsArray = Array.isArray(invitationIds) ? invitationIds : typeof invitationIds === "string" ? [invitationIds] : [];
    const validObjectIds = idsArray
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (validObjectIds.length === 0) throw new Error('INVALID_INVITATIONS');

    const invitations = await Invitation.find({ _id: { $in: validObjectIds }, eventId }).populate({ path: 'inviteeId', select: '+qrTokenCipher +invitationTokenCipher' });
    if (invitations.length === 0) throw new Error('INVALID_INVITATIONS');

    const results = [];

    const outcomes = await mapLimit(invitations, sendConcurrency(), async (invitation) => {
      const invitee = invitation.inviteeId as any;
      if (invitee && !(await claimInviteeForIssue(invitee._id))) {
        return { invitationId: invitation._id, inviteeId: invitee._id, inviteeName: invitee.name, status: 'SKIPPED', failureReason: SKIPPED_IN_PROGRESS } as any;
      }
      try {
      if (!invitee) {
        invitation.status = InvitationDeliveryStatus.FAILED;
        invitation.failureReason = 'INVITEE_DELETED';
        await invitation.save();
        return { invitationId: invitation._id, status: 'FAILED', failureReason: 'INVITEE_DELETED' } as any;
      }

      if (await eventIsCancelled(eventId)) {
        return { invitationId: invitation._id, inviteeId: invitee._id, inviteeName: invitee.name, status: 'SKIPPED', failureReason: SKIPPED_EVENT_CANCELLED } as any;
      }
      // A revoked pass is not re-sent: that would deliver a pass that does not work. Replacing it is a deliberate, recorded action.
      if (invitee.credentialRevokedAt) {
        return { invitationId: invitation._id, inviteeId: invitee._id, inviteeName: invitee.name, status: 'SKIPPED', failureReason: SKIPPED_PASS_REVOKED } as any;
      }
      const activeChannel = (channelOverride || invitation.channel) as DeliveryChannel;
      const use = channelsForInvitee(activeChannel, invitee);
      if (!use.email && !use.whatsapp) {
        // Nothing usable: the guest's current pass and delivery record stay as they are
        return { invitationId: invitation._id, inviteeId: invitee._id, inviteeName: invitee.name, status: 'SKIPPED', failureReason: SKIPPED_NO_CONTACT } as any;
      }

      // A re-send mints a new ADMISSION credential (the QR already delivered stops working); the invitation link is unchanged
      const rawToken = generateSecureToken();
      const tokenHash = hashToken(rawToken);
      const invitationToken = planInvitationToken(invitee);
      const invitationUrl = invitationUrlFor(invitationToken.raw);

      const qrDataUrl = await generateQRCodeDataURL(admissionPayloadFor(rawToken));
      const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
      const qrBuffer = Buffer.from(base64Data, 'base64');

      const resendInvitation = new Invitation({
        eventId,
        inviteeId: invitee._id,
        channel: activeChannel,
        status: InvitationDeliveryStatus.PENDING,
        tokenHash
      });

      const shouldSendEmail = use.email;
      const shouldSendWhatsApp = use.whatsapp;

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
          invitee: { id: (invitee._id as any).toString(), ...cardGuestLines(invitee, (event as any).cardInfo, (event as any).cardDisplay) },
          event: {
            id: (event._id as any).toString(),
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
            isVirtual: (event as any).format === 'VIRTUAL',
            description: (event as any).description,
            organizerName: cardContext.organizerName,
            contactNumber: (event as any).contactNumber
          },
          sessions: assignedSessions,
          qrDataUrl,
          invitationUrl: admissionPayloadFor(rawToken), // the card's QR (fallback) is always the admission credential
          cardDesign,
          designSpec: cardContext.designSpec,
          cardDisplay: (event as any).cardDisplay
        });
      } catch (err) {
        console.error('Failed to generate high-resolution invitation card PNG for resend:', err);
        cardBuffer = qrBuffer;
      }

      if (shouldSendEmail && !(await eventIsCancelled(eventId))) {
        try {
          if (!invitee.email) throw new Error('MISSING_EMAIL');

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
            asksDietary: !!(event as any).dietaryPreference?.enabled && Array.isArray((event as any).dietaryPreference?.options) && (event as any).dietaryPreference.options.length > 0,
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
            isVirtual: (event as any).format === 'VIRTUAL',
            description: (event as any).description,
            contactNumber: (event as any).contactNumber,
            rsvpBy: (event as any).rsvp?.enabled ? (event as any).rsvp?.acceptanceLastDate : undefined,
            showQr: (event as any).cardDisplay?.qr !== false,
            sessions: assignedSessions,
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
            ...((event as any).cardDisplay?.qr !== false && !cardBuffer?.length ? [{
              filename: 'invitation-qr.png',
              content: qrBuffer,
              cid,
              contentType: 'image/png'
            }] : []),
            ...(brand.logo ? [{ filename: 'organizer-logo', content: brand.logo.content, cid: `organizer-logo-${invitee._id}`, contentType: brand.logo.contentType }] : []),
            // the details icons, and the LGPSM logo while the organizer has none of their own
            ...(await inlineImagesFor(htmlContent))
          ];

          await sendEmail(invitee.email, invitationEmailSubject(event.title, true), htmlContent, attachments);
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

      if (shouldSendWhatsApp && !(await eventIsCancelled(eventId))) {
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
          whatsappErrReason = describeWhatsAppError(err.message);
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
        if (invitationToken.persist) { invitee.invitationTokenHash = invitationToken.hash; invitee.invitationTokenCipher = invitationToken.cipher; }
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
      if (resendInvitation.status === InvitationDeliveryStatus.SENT) {
        await credentialService.recordIssuance({ invitee, tokenHash, source: 'RESEND', actorId: organizerId, actorRole: userRole || 'ORGANIZER', organizerId: (event as any).organizerId }).catch((e) => console.error('Credential history not recorded:', e?.message));
      }
      if (resendInvitation.status === InvitationDeliveryStatus.SENT && (await eventIsCancelled(eventId))) {
        await cancellationNoticeService.enqueueLateInvitee(eventId, invitee._id).catch((e) => console.error('Late cancellation notice failed:', e?.message));
      }
      const cleanMobile = invitee.mobile ? whatsappService.normalizePhoneNumber(invitee.mobile) : '';
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
      } as any;
      } finally {
        if (invitee) await releaseInviteeClaim(invitee._id).catch((e) => console.error('Delivery claim release failed:', e?.message));
      }
    });
    results.push(...outcomes);

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

    const safePage = Math.max(page, 1), safeLimit = Math.min(Math.max(limit, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const invitations = await Invitation.find({ eventId })
      .populate('inviteeId', 'name email mobile invitationStatus rsvpStatus')
      .skip(skip)
      .limit(safeLimit)
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
      page: safePage,
      totalPages: Math.ceil(total / safeLimit)
    };
  },

  // Hides the event's delivery history. Records are kept: Resend addresses them by id and check-in uses them to
  // tell a superseded QR from an unknown one. Sending or resending to a guest makes that guest's entry visible again.
  async clearHistory(eventId: string, userOrOrganizerId: any): Promise<{ cleared: number }> {
    const isUserObj = typeof userOrOrganizerId === 'object' && userOrOrganizerId !== null;
    const organizerId = isUserObj ? userOrOrganizerId.userId : userOrOrganizerId;
    const userRole = isUserObj ? userOrOrganizerId.role : undefined;

    const event = userRole === Role.ADMIN || userRole === 'ADMIN'
      ? await Event.findById(eventId)
      : await Event.findOne({ _id: eventId, organizerId });
    if (!event) throw new Error('EVENT_NOT_FOUND');

    const result = await Invitation.updateMany(
      { eventId, clearedAt: { $exists: false } },
      { $set: { clearedAt: new Date() } }
    );
    return { cleared: result.modifiedCount };
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
    // The sample card (no guest) is the same for everyone who may see this event, so it is rendered once and kept briefly. The key
    // carries the event's last update; the short life covers edits to the template or organization that do not touch the event.
    const sampleKey = !inviteeId ? `${event._id}:${(event as any).updatedAt?.getTime?.() ?? 0}:${(event as any).templateId ?? ''}` : null;
    if (sampleKey) {
      const hit = sampleCards.get(sampleKey);
      if (hit && hit.until > Date.now()) return { png: hit.png, qr: 'SAMPLE' as const };
    }
    // The design follows the organizer's template, or the event's type when none was chosen (see cardTemplates/designs.ts)
    const cardContext = await loadCardContext(event);
    const cardDesign = cardContext.cardDesign;
    // the organizer's logo goes at the bottom of each invitation email (read once per send)
    const brand = await organizerBrand(event.organizerId);
    // Resolved once per event (not per invitee) — the same organizer-uploaded photo goes on
    // every invitee's card for this event.
    const eventPhotoBase64 = await resolveImageKeyBase64((event as any).media?.logoKey);

    // Without a specific invitee the preview shows the design's sample guest lines
    let invitee: any = null;
    if (inviteeId && mongoose.Types.ObjectId.isValid(inviteeId)) {
      invitee = await Invitee.findOne({ _id: inviteeId, eventId }).select('+qrTokenCipher');
    }
    const guestLines = cardGuestLines(invitee, (event as any).cardInfo, (event as any).cardDisplay);

    const allSessions = await Session.find({ eventId }).sort({ 'schedule.start': 1 }).lean();
    const { eventDate, dayOfWeek, eventTime, venue, locationSub, sessions: assignedSessions } =
      buildInvitationContent(event as any, allSessions as any, invitee);

    // A guest who has been sent an invitation gets their current, check-in-valid QR. Otherwise the
    // card carries a clearly marked sample QR that check-in recognises and rejects.
    const issuedToken = invitee ? currentIssuedToken(invitee) : null;
    const invitationUrl = issuedToken ? admissionPayloadFor(issuedToken) : previewSampleUrl();
    const qrDataUrl = await generateQRCodeDataURL(invitationUrl);

    const png = await invitationCardService.generateInvitationCardPNG({
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
            isVirtual: (event as any).format === 'VIRTUAL',
            description: (event as any).description,
            organizerName: cardContext.organizerName,
            contactNumber: (event as any).contactNumber
      },
      sessions: assignedSessions,
      qrDataUrl,
      invitationUrl,
      cardDesign,
      designSpec: cardContext.designSpec,
      cardDisplay: (event as any).cardDisplay
    });
    if (sampleKey && !issuedToken) {
      if (sampleCards.size >= 200) sampleCards.delete(sampleCards.keys().next().value as string);
      sampleCards.set(sampleKey, { png, until: Date.now() + 5 * 60 * 1000 });
    }
    return { png, qr: issuedToken ? ('ISSUED' as const) : ('SAMPLE' as const) };
  }
};

function currentIssuedToken(invitee: { qrTokenHash?: string; qrTokenCipher?: string }): string | null {
  const token = decryptToken(invitee.qrTokenCipher);
  return token && invitee.qrTokenHash && hashToken(token) === invitee.qrTokenHash ? token : null;
}

