import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl } from '../src/models/Session';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation, DeliveryChannel, InvitationDeliveryStatus } from '../src/models/Invitation';
import { CheckIn } from '../src/models/CheckIn';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';
import { encryptToken, decryptToken } from '../src/utils/tokenCipher';
import { invitationBaseUrl, invitationUrlFor, parseInvitationQrPayload, previewSampleUrl } from '../src/utils/qrPayload';
import { invitationCardService } from '../src/services/invitationCard.service';

describe('QR payload parser', () => {
  const token = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);

  it('accepts a raw token and normalises case', () => {
    expect(parseInvitationQrPayload(token)).toEqual({ ok: true, token });
    expect(parseInvitationQrPayload(`  ${token.toUpperCase()}\n`)).toEqual({ ok: true, token });
  });

  it('accepts the configured invitation URL, with or without trailing slash / query', () => {
    expect(parseInvitationQrPayload(invitationUrlFor(token))).toEqual({ ok: true, token });
    expect(parseInvitationQrPayload(`${invitationUrlFor(token)}/`)).toEqual({ ok: true, token });
    expect(parseInvitationQrPayload(`${invitationUrlFor(token)}?utm=mail#x`)).toEqual({ ok: true, token });
  });

  it('rejects other hosts, ports, paths and embedded credentials', () => {
    const base = new URL(invitationBaseUrl());
    expect(parseInvitationQrPayload(`https://evil.example.com/invitation/${token}`)).toEqual({ ok: false, reason: 'UNTRUSTED_URL' });
    expect(parseInvitationQrPayload(`${base.protocol}//${base.hostname}:1${base.port || '0'}${base.pathname}/${token}`)).toEqual({ ok: false, reason: 'UNTRUSTED_URL' });
    expect(parseInvitationQrPayload(`${base.origin}/elsewhere/${token}`)).toEqual({ ok: false, reason: 'UNTRUSTED_URL' });
    expect(parseInvitationQrPayload(`${base.protocol}//user:pw@${base.host}${base.pathname}/${token}`)).toEqual({ ok: false, reason: 'UNTRUSTED_URL' });
  });

  it('rejects malformed payloads and recognises preview samples', () => {
    expect(parseInvitationQrPayload('')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(parseInvitationQrPayload(undefined)).toEqual({ ok: false, reason: 'EMPTY' });
    expect(parseInvitationQrPayload('hello world')).toEqual({ ok: false, reason: 'UNSUPPORTED_FORMAT' });
    expect(parseInvitationQrPayload(token.slice(1))).toEqual({ ok: false, reason: 'UNSUPPORTED_FORMAT' });
    expect(parseInvitationQrPayload(`${invitationUrlFor(token)}/extra`)).toEqual({ ok: false, reason: 'UNSUPPORTED_FORMAT' });
    expect(parseInvitationQrPayload(previewSampleUrl())).toEqual({ ok: false, reason: 'PREVIEW_SAMPLE' });
  });

  it('round-trips tokens through the at-rest cipher and rejects tampering', () => {
    const enc = encryptToken(token);
    expect(enc).not.toContain(token);
    expect(decryptToken(enc)).toBe(token);
    expect(decryptToken(enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA'))).toBeNull();
    expect(decryptToken(undefined)).toBeNull();
  });
});

describe('QR check-in pipeline (preview card -> scan)', () => {
  let mongoServer: MongoMemoryServer;
  let organizerToken: string;
  let event: any;
  let session: any;
  let sent: any;
  let sentToken: string;
  let unsent: any;
  let cardSpy: jest.SpyInstance;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([User, Event, Session, Invitee, Invitation, CheckIn].map((m: any) => m.deleteMany({})));
    cardSpy = jest.spyOn(invitationCardService, 'generateInvitationCardPNG').mockResolvedValue(Buffer.from('png'));

    const organizer = await User.create({ fullName: 'Org', email: 'org@example.com', role: Role.ORGANIZER, isActive: true });
    organizerToken = generateAccessToken(String(organizer._id), organizer.role);
    event = await Event.create({
      organizerId: organizer._id, title: 'Summit', description: 'd', categoryId: new mongoose.Types.ObjectId(),
      format: EventFormat.PHYSICAL, schedule: { start: new Date(), end: new Date() }, status: EventStatus.PUBLISHED,
      rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: false },
    });
    session = await Session.create({ eventId: event._id, name: 'Entry', schedule: event.schedule, accessControl: AccessControl.ONLY_ONCE });

    sentToken = generateSecureToken();
    sent = await Invitee.create({
      eventId: event._id, name: 'Priya Sen', email: 'priya@example.com', invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED, qrTokenHash: hashToken(sentToken), qrTokenCipher: encryptToken(sentToken),
      sessionAccess: [{ sessionId: session._id, allowed: true }],
    });
    unsent = await Invitee.create({ eventId: event._id, name: 'Arjun Das', email: 'arjun@example.com', sessionAccess: [{ sessionId: session._id, allowed: true }] });
  });

  afterEach(() => cardSpy.mockRestore());

  const preview = (inviteeId: string) =>
    request(app).get(`/api/v1/events/${event._id}/invitations/preview?inviteeId=${inviteeId}`).set('Authorization', `Bearer ${organizerToken}`);
  const scan = (qrCode: string, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/checkins/scan').set('Authorization', `Bearer ${organizerToken}`).send({ qrCode, eventId: String(event._id), ...extra });
  const cardUrl = () => cardSpy.mock.calls[cardSpy.mock.calls.length - 1][0].invitationUrl as string;

  it('preview card of an invited guest carries their real pass, which checks in and persists', async () => {
    const res = await preview(String(sent._id));
    expect(res.status).toBe(200);
    expect(res.headers['x-invitation-qr']).toBe('ISSUED');
    expect(cardUrl()).toBe(invitationUrlFor(sentToken));

    const checkIn = await scan(cardUrl(), { sessionId: String(session._id) });
    expect(checkIn.status).toBe(201);
    expect(checkIn.body.data.invitee.name).toBe('Priya Sen');
    expect(checkIn.body.data.session.name).toBe('Entry');
    expect(checkIn.body.data.checkInMethod).toBe('QR');
    const stored = await CheckIn.findOne({ inviteeId: sent._id, sessionId: session._id });
    expect(stored).not.toBeNull();
  });

  it('raw token works the same as the URL; the second scan is a business-rule denial', async () => {
    expect((await scan(sentToken, { sessionId: String(session._id) })).status).toBe(201);
    const again = await scan(invitationUrlFor(sentToken), { sessionId: String(session._id) });
    expect(again.status).toBe(409);
    expect(again.body.code).toBeUndefined();
  });

  it('preview of a guest without an invitation is a marked sample that check-in rejects', async () => {
    const res = await preview(String(unsent._id));
    expect(res.headers['x-invitation-qr']).toBe('SAMPLE');
    const denied = await scan(cardUrl());
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('QR_PREVIEW_SAMPLE');
  });

  it('distinguishes untrusted, malformed, unknown and superseded passes without creating records', async () => {
    const foreign = await scan(`https://evil.example.com/invitation/${sentToken}`);
    expect([foreign.status, foreign.body.code]).toEqual([400, 'QR_URL_UNTRUSTED']);

    const malformed = await scan('not a pass');
    expect([malformed.status, malformed.body.code]).toEqual([400, 'QR_FORMAT_UNSUPPORTED']);

    const unknown = await scan(generateSecureToken());
    expect([unknown.status, unknown.body.code]).toEqual([404, 'INVALID_QR_TOKEN']);

    const oldToken = generateSecureToken();
    await Invitation.create({ eventId: event._id, inviteeId: sent._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.SENT, tokenHash: hashToken(oldToken) });
    const superseded = await scan(oldToken);
    expect([superseded.status, superseded.body.code]).toEqual([410, 'QR_TOKEN_SUPERSEDED']);

    expect(await CheckIn.countDocuments()).toBe(0);
  });

  it('a pass for another event is refused', async () => {
    const res = await scan(sentToken, { eventId: String(new mongoose.Types.ObjectId()) });
    expect(res.status).toBe(400);
    expect(await CheckIn.countDocuments()).toBe(0);
  });

  it('never returns the encrypted token with invitee data', async () => {
    const found = await Invitee.findById(sent._id).lean();
    expect((found as any).qrTokenCipher).toBeUndefined();
  });
});
