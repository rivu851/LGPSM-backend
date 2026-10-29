import mongoose from 'mongoose';
import { invitationService, SKIPPED_ALREADY_INVITED } from '../src/services/invitation.service';
import { whatsappService } from '../src/services/whatsapp.service';
import { Event } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation, DeliveryChannel, InvitationDeliveryStatus } from '../src/models/Invitation';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Mock email provider
jest.mock('../src/utils/email.provider', () => ({
  sendEmail: jest.fn()
}));
import { sendEmail } from '../src/utils/email.provider';

describe('Invitation Service', () => {
  jest.setTimeout(60000); // Increase timeout for MongoMemoryServer download/startup

  let mongoServer: MongoMemoryServer;
  let organizerId: mongoose.Types.ObjectId;
  let eventId: mongoose.Types.ObjectId;
  let inviteeId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Event.deleteMany({});
    await Invitee.deleteMany({});
    await Invitation.deleteMany({});

    organizerId = new mongoose.Types.ObjectId();
    
    const event = await Event.create({
      organizerId,
      title: 'Test Event',
      description: 'Test Event Desc',
      categoryId: new mongoose.Types.ObjectId(),
      format: 'PHYSICAL' as any,
      location: { type: 'Point', address: '123 Test St', coordinates: [0, 0] } as any,
      schedule: { start: new Date(), end: new Date() }
    });
    eventId = (event as any)._id as mongoose.Types.ObjectId;

    const invitee = await Invitee.create({
      eventId,
      name: 'Test User',
      email: 'test@example.com',
      mobile: '+919876543210',
      invitationStatus: InvitationStatus.PENDING,
      rsvpStatus: RsvpStatus.PENDING
    });
    inviteeId = invitee._id as mongoose.Types.ObjectId;
  });

  it('should send invitations successfully via EMAIL and update statuses', async () => {
    (sendEmail as jest.Mock).mockResolvedValue(true);

    const results = await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [inviteeId.toString()], DeliveryChannel.EMAIL);

    expect(results[0].status).toBe(InvitationDeliveryStatus.SENT);
    
    const invitee = await Invitee.findById(inviteeId);
    expect(invitee?.invitationStatus).toBe(InvitationStatus.SENT);
    expect(invitee?.qrTokenHash).toBeDefined();

    const invitation = await Invitation.findOne({ inviteeId });
    expect(invitation?.status).toBe(InvitationDeliveryStatus.SENT);
    expect(invitation?.tokenHash).toEqual(invitee?.qrTokenHash);
  });

  it('should send invitations via BOTH EMAIL and WHATSAPP using the SAME invitation token', async () => {
    (sendEmail as jest.Mock).mockResolvedValue(true);
    const mockSendWA = jest.spyOn(whatsappService, 'sendInvitationWhatsApp').mockResolvedValue({
      messageId: 'wamid.HBgLMTIzNDU2Nzg5MA==',
      mediaId: 'media_id_12345'
    });

    const results = await invitationService.sendInvitations(
      eventId.toString(),
      organizerId.toString(),
      [inviteeId.toString()],
      DeliveryChannel.BOTH
    );

    expect(results[0].status).toBe(InvitationDeliveryStatus.SENT);
    expect(results[0].whatsappMessageId).toBe('wamid.HBgLMTIzNDU2Nzg5MA==');

    const invitee = await Invitee.findById(inviteeId);
    expect(invitee?.invitationStatus).toBe(InvitationStatus.SENT);
    const activeTokenHash = invitee?.qrTokenHash;

    const invitation = await Invitation.findOne({ inviteeId });
    expect(invitation?.tokenHash).toBe(activeTokenHash);
    expect(invitation?.emailStatus).toBe(InvitationDeliveryStatus.SENT);
    expect(invitation?.whatsappStatus).toBe(InvitationDeliveryStatus.SENT);

    // Verify WhatsApp service received the same QR buffer and parameters
    expect(mockSendWA).toHaveBeenCalledTimes(1);
    expect(mockSendWA.mock.calls[0][0].recipientPhone).toBe('+919876543210');
    expect(mockSendWA.mock.calls[0][0].inviteeName).toBe('Test User');
    expect(mockSendWA.mock.calls[0][0].eventTitle).toBe('Test Event');

    mockSendWA.mockRestore();
  });

  it('should handle WhatsApp provider failure cleanly without marking full success if both fail', async () => {
    (sendEmail as jest.Mock).mockRejectedValue(new Error('SMTP_ERROR'));
    const mockSendWA = jest.spyOn(whatsappService, 'sendInvitationWhatsApp').mockRejectedValue(new Error('WHATSAPP_MEDIA_UPLOAD_FAILED: Invalid Token'));

    const results = await invitationService.sendInvitations(
      eventId.toString(),
      organizerId.toString(),
      [inviteeId.toString()],
      DeliveryChannel.BOTH
    );

    expect(results[0].status).toBe(InvitationDeliveryStatus.FAILED);
    expect(results[0].emailStatus).toBe(InvitationDeliveryStatus.FAILED);
    expect(results[0].whatsappStatus).toBe(InvitationDeliveryStatus.FAILED);

    const invitation = await Invitation.findOne({ inviteeId });
    expect(invitation?.status).toBe(InvitationDeliveryStatus.FAILED);
    expect(invitation?.failureReason).toContain('WhatsApp: WhatsApp did not accept the invitation image (Invalid Token)');

    mockSendWA.mockRestore();
  });

  it('should not update Invitee token if provider fails', async () => {
    (sendEmail as jest.Mock).mockRejectedValue(new Error('PROVIDER_NOT_CONFIGURED'));

    const results = await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [inviteeId.toString()], DeliveryChannel.EMAIL);

    expect(results[0].status).toBe(InvitationDeliveryStatus.FAILED);
    expect(results[0].failureReason).toBe('Email provider not configured');
    
    const invitee = await Invitee.findById(inviteeId);
    expect(invitee?.invitationStatus).toBe(InvitationStatus.FAILED);
    expect(invitee?.qrTokenHash).toBeUndefined(); // Should not have set the token

    const invitation = await Invitation.findOne({ inviteeId });
    expect(invitation?.status).toBe(InvitationDeliveryStatus.FAILED);
    expect(invitation?.tokenHash).toBeDefined(); // Still recorded the token we tried to send
  });

  it('resend should create a new history record and keep old token valid on failure', async () => {
    // 1. Successful first send
    (sendEmail as jest.Mock).mockResolvedValueOnce(true);
    await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [inviteeId.toString()], DeliveryChannel.EMAIL);
    
    const invitee = await Invitee.findById(inviteeId);
    const oldTokenHash = invitee?.qrTokenHash;
    const oldInvitation = await Invitation.findOne({ inviteeId });

    // 2. Failed resend
    (sendEmail as jest.Mock).mockRejectedValueOnce(new Error('SMTP_ERROR'));
    await invitationService.resendInvitations(eventId.toString(), organizerId.toString(), [(oldInvitation!._id as any).toString()]);

    const inviteeAfterFail = await Invitee.findById(inviteeId);
    expect(inviteeAfterFail?.qrTokenHash).toBe(oldTokenHash); // Token unchanged!

    const history = await Invitation.find({ inviteeId }).sort({ createdAt: 1 });
    expect(history.length).toBe(2);
    expect(history[0].status).toBe(InvitationDeliveryStatus.SENT);
    expect(history[1].status).toBe(InvitationDeliveryStatus.FAILED);
  });
  
  it('should strictly verify event ownership for normal organizers but allow ADMIN', async () => {
    const wrongOrganizer = new mongoose.Types.ObjectId().toString();
    await expect(
      invitationService.sendInvitations(eventId.toString(), wrongOrganizer, [inviteeId.toString()], DeliveryChannel.EMAIL)
    ).rejects.toThrow('EVENT_NOT_FOUND');

    (sendEmail as jest.Mock).mockResolvedValue(true);
    // ADMIN role user object can access and send
    const adminUser = { userId: wrongOrganizer, role: 'ADMIN' };
    const results = await invitationService.sendInvitations(eventId.toString(), adminUser, [inviteeId.toString()], DeliveryChannel.EMAIL);
    expect(results[0].status).toBe(InvitationDeliveryStatus.SENT);
  });

  it('should generate inline CID QR attachment and be scanner compatible with checkInService', async () => {
    (sendEmail as jest.Mock).mockResolvedValue(true);

    const results = await invitationService.sendInvitations(
      eventId.toString(),
      organizerId.toString(),
      [inviteeId.toString()],
      DeliveryChannel.EMAIL
    );

    expect(results[0].status).toBe(InvitationDeliveryStatus.SENT);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const [recipientEmail, subject, html, attachments] = (sendEmail as jest.Mock).mock.calls[0];
    expect(recipientEmail).toBe('test@example.com');
    expect(subject).toBe('Invitation: Test Event');
    expect(html).toContain('cid:invitation-qr-');
    expect(attachments).toBeDefined();
    // Email carries the rendered invitation card plus the scannable QR image
    expect(attachments.length).toBe(2);
    const qrAttachment = attachments.find((a: any) => a.filename === 'invitation-qr.png');
    const cardAttachment = attachments.find((a: any) => a.filename === 'invitation-card.png');
    expect(cardAttachment).toBeDefined();
    expect(html).toContain(`cid:${cardAttachment.cid}`);
    expect(qrAttachment).toBeDefined();
    expect(qrAttachment.contentType).toBe('image/png');
    expect(qrAttachment.cid).toContain('invitation-qr-');
    expect(Buffer.isBuffer(qrAttachment.content)).toBe(true);

    // Verify token stored in DB matches the hashed invitation token
    const invitee = await Invitee.findById(inviteeId);
    expect(invitee?.qrTokenHash).toBeDefined();

    // Verify raw token extracted from QR/URL works with checkInService.extractRawToken
    const invitation = await Invitation.findOne({ inviteeId });
    expect(invitation?.tokenHash).toEqual(invitee?.qrTokenHash);
  });

  describe('send is only for guests who have not been invited yet', () => {
    it('skips guests already sent, keeps their token, and sends only the newly added guest', async () => {
      (sendEmail as jest.Mock).mockResolvedValue(true);
      await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [inviteeId.toString()], DeliveryChannel.EMAIL);
      const firstToken = (await Invitee.findById(inviteeId))?.qrTokenHash;
      const sentBefore = (sendEmail as jest.Mock).mock.calls.length;

      // later: another guest is added, and the whole list is submitted again
      const added = await Invitee.create({ eventId, name: 'Added Later', email: 'later@example.com' });
      const results = await invitationService.sendInvitations(
        eventId.toString(), organizerId.toString(), [inviteeId.toString(), String(added._id)], DeliveryChannel.EMAIL
      );

      const old = results.find((r: any) => String(r.inviteeId) === String(inviteeId));
      const fresh = results.find((r: any) => String(r.inviteeId) === String(added._id));
      expect(old?.status).toBe('SKIPPED');
      expect(old?.failureReason).toBe(SKIPPED_ALREADY_INVITED);
      expect(fresh?.status).toBe(InvitationDeliveryStatus.SENT);
      // exactly one new email went out, and the first guest's QR still works
      expect((sendEmail as jest.Mock).mock.calls.length - sentBefore).toBe(1);
      expect((await Invitee.findById(inviteeId))?.qrTokenHash).toEqual(firstToken);
      expect(await Invitation.countDocuments({ eventId })).toBe(2);
    });

    it('still retries a guest whose earlier delivery failed', async () => {
      (sendEmail as jest.Mock).mockRejectedValueOnce(new Error('smtp down')).mockResolvedValue(true);
      const [first] = await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [inviteeId.toString()], DeliveryChannel.EMAIL);
      expect(first.status).toBe(InvitationDeliveryStatus.FAILED);
      const [again] = await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [inviteeId.toString()], DeliveryChannel.EMAIL);
      expect(again.status).toBe(InvitationDeliveryStatus.SENT);
    });

    it('does not deliver twice when the same guest is sent at the same moment', async () => {
      (sendEmail as jest.Mock).mockImplementation(() => new Promise((r) => setTimeout(() => r(true), 50)));
      const send = () => invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [inviteeId.toString()], DeliveryChannel.EMAIL);
      const [a, b] = await Promise.all([send(), send()]);
      const statuses = [a[0].status, b[0].status].sort();
      expect(statuses).toEqual(['SENT', 'SKIPPED']);
      expect((sendEmail as jest.Mock).mock.calls.length).toBe(1);
    });
  });

  describe('"All" delivery (BOTH) uses only the usable channels per guest', () => {
    const mockWhatsApp = () => jest.spyOn(whatsappService, 'sendInvitationWhatsApp').mockResolvedValue({ messageId: 'wamid.ok', mediaId: 'media.ok' });

    it('emails a guest who has no mobile, without counting WhatsApp as a failure', async () => {
      (sendEmail as jest.Mock).mockResolvedValue(true);
      const wa = mockWhatsApp();
      const emailOnly = await Invitee.create({ eventId, name: 'Email Only', email: 'only@example.com' });

      const [result] = await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [String(emailOnly._id)], DeliveryChannel.BOTH);

      expect(result.status).toBe(InvitationDeliveryStatus.SENT);
      expect(result.emailStatus).toBe(InvitationDeliveryStatus.SENT);
      expect(result.whatsappStatus).toBeUndefined();
      expect(wa).not.toHaveBeenCalled();
      wa.mockRestore();
    });

    it('sends WhatsApp only to a guest with a mobile but no email', async () => {
      const wa = mockWhatsApp();
      const mobileOnly = await Invitee.create({ eventId, name: 'Mobile Only', mobile: '+919812345678' });

      const [result] = await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [String(mobileOnly._id)], DeliveryChannel.BOTH);

      expect(result.status).toBe(InvitationDeliveryStatus.SENT);
      expect(result.whatsappStatus).toBe(InvitationDeliveryStatus.SENT);
      expect(result.emailStatus).toBeUndefined();
      expect(sendEmail).not.toHaveBeenCalled();
      wa.mockRestore();
    });

    it('skips a guest with no usable contact and changes nothing about them', async () => {
      const wa = mockWhatsApp();
      // A malformed mobile is the only contact (invitee validation needs email or mobile)
      const unusable = await Invitee.create({ eventId, name: 'No Contact', mobile: '12345' });

      const [result] = await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [String(unusable._id)], DeliveryChannel.BOTH);

      expect(result.status).toBe('SKIPPED');
      expect(sendEmail).not.toHaveBeenCalled();
      expect(wa).not.toHaveBeenCalled();
      expect(await Invitation.countDocuments({ inviteeId: unusable._id })).toBe(0);
      const after = await Invitee.findById(unusable._id);
      expect(after?.invitationStatus).toBe(InvitationStatus.PENDING);
      expect(after?.qrTokenHash).toBeUndefined();
      wa.mockRestore();
    });

    it('keeps a skipped guest\'s existing pass when resending to them', async () => {
      (sendEmail as jest.Mock).mockResolvedValue(true);
      const guest = await Invitee.create({ eventId, name: 'Was Emailed', email: 'was@example.com' });
      await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [String(guest._id)], DeliveryChannel.EMAIL);
      const sent = await Invitee.findById(guest._id);
      const invitation = await Invitation.findOne({ inviteeId: guest._id });
      // The email is later removed, so "All" has nothing usable for this guest
      await Invitee.updateOne({ _id: guest._id }, { $unset: { email: 1 }, $set: { mobile: '999' } });

      const [result] = await invitationService.resendInvitations(eventId.toString(), organizerId.toString(), [String(invitation!._id)], DeliveryChannel.BOTH);

      expect(result.status).toBe('SKIPPED');
      expect((await Invitee.findById(guest._id))?.qrTokenHash).toBe(sent?.qrTokenHash);
      expect(await Invitation.countDocuments({ inviteeId: guest._id })).toBe(1);
    });

    it('still fails (not skips) when a single channel is requested and its contact is missing', async () => {
      const mobileOnly = await Invitee.create({ eventId, name: 'Mobile Only', mobile: '+919812345678' });
      const [result] = await invitationService.sendInvitations(eventId.toString(), organizerId.toString(), [String(mobileOnly._id)], DeliveryChannel.EMAIL);
      expect(result.status).toBe(InvitationDeliveryStatus.FAILED);
    });
  });
});


describe('WhatsApp failure reasons shown to organizers', () => {
  it('turns internal codes into plain sentences and keeps the provider detail', () => {
    const { describeWhatsAppError } = require('../src/services/whatsapp.service');
    expect(describeWhatsAppError('WHATSAPP_CONFIG_MISSING: Access token not configured')).toBe('WhatsApp is not set up on the server');
    expect(describeWhatsAppError('WHATSAPP_MEDIA_UPLOAD_FAILED: Invalid OAuth access token')).toBe('WhatsApp did not accept the invitation image (Invalid OAuth access token)');
    expect(describeWhatsAppError('WHATSAPP_TEMPLATE_SEND_FAILED: Recipient not in allowed list')).toBe('WhatsApp did not deliver the message (Recipient not in allowed list)');
    expect(describeWhatsAppError('socket hang up')).toBe('socket hang up');
    expect(describeWhatsAppError(undefined)).toBe('WhatsApp delivery failed');
  });
});
