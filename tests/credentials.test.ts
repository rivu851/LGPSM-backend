import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation, DeliveryChannel, InvitationDeliveryStatus } from '../src/models/Invitation';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { CheckIn } from '../src/models/CheckIn';
import { AuditLog } from '../src/models/AuditLog';
import { CredentialEvent } from '../src/models/CredentialEvent';
import { PassNotice } from '../src/models/PassNotice';
import { auditLogRepository } from '../src/repositories/auditLog.repository';
import { whatsappService } from '../src/services/whatsapp.service';
import { invitationService } from '../src/services/invitation.service';
import { passNoticeService } from '../src/services/passNotice.service';
import * as emailProvider from '../src/utils/email.provider';
import { credentialStatus, replacementAfterRevocation, validateReason } from '../src/utils/credentialPolicy';
import { encryptToken } from '../src/utils/tokenCipher';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

// every guest of an event has their own phone number (the database allows one active guest per number)
let mobileSeq = 0;
const uniqueMobile = () => `98765${String(43210 + ++mobileSeq)}`;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const HOUR = 3600e3;
jest.setTimeout(30_000); // each replacement renders a card

// the audit entry of a critical action is completed just after the response: wait until it is no longer PENDING
async function auditRow(action: string): Promise<any> {
  for (let i = 0; i < 80 && (await AuditLog.countDocuments({ action, status: { $ne: 'PENDING' } })) === 0; i++) await new Promise((r) => setTimeout(r, 25));
  return AuditLog.findOne({ action });
}

async function settle(tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (!(await PassNotice.countDocuments({ $or: [{ 'email.status': { $in: ['PENDING', 'SENDING'] } }, { 'whatsapp.status': { $in: ['PENDING', 'SENDING'] } }] }))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('P4 — individual access pass: revoke, replace, history', () => {
  let mongo: MongoMemoryServer;
  let org: any, other: any, staff: any, admin: any;
  let tOrg: string, tOther: string, tStaff: string, tAdmin: string;
  let event: any;
  const guests: Record<string, { inv: any; raw: string }> = {};
  let emailSpy: jest.SpyInstance, waSpy: jest.SpyInstance;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([CheckIn, CredentialEvent, PassNotice].map((m: any) => m.syncIndexes()));
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const invite = async (key: string, name: string, opts: { channel?: 'EMAIL' | 'WHATSAPP' | 'BOTH' | null; rsvp?: RsvpStatus; issued?: boolean } = {}) => {
    const raw = generateSecureToken();
    const issued = opts.issued !== false;
    const inv: any = await Invitee.create({
      eventId: event._id, name, email: `${key}@x.com`, mobile: uniqueMobile(), invitationStatus: issued ? InvitationStatus.SENT : InvitationStatus.PENDING,
      rsvpStatus: opts.rsvp ?? RsvpStatus.ACCEPTED, sessionAccess: [],
      ...(issued ? { qrTokenHash: hashToken(raw), qrTokenCipher: encryptToken(raw), credentialVersion: 1 } : {})
    });
    const channel = opts.channel === undefined ? 'EMAIL' : opts.channel;
    if (issued && channel) {
      await Invitation.create({
        eventId: event._id, inviteeId: inv._id, tokenHash: hashToken(raw), channel, status: InvitationDeliveryStatus.SENT,
        ...(channel !== 'WHATSAPP' ? { emailStatus: InvitationDeliveryStatus.SENT } : {}), ...(channel !== 'EMAIL' ? { whatsappStatus: InvitationDeliveryStatus.SENT } : {})
      });
      await CredentialEvent.create({ eventId: event._id, inviteeId: inv._id, organizerId: org._id, type: 'ISSUED', version: 1, source: 'SEND', tokenHash: hashToken(raw) });
    }
    guests[key] = { inv, raw };
  };

  beforeEach(async () => {
    await Promise.all([User, Event, Session, Invitee, Invitation, SystemUserAssignment, CheckIn, AuditLog, CredentialEvent, PassNotice].map((m: any) => m.deleteMany({})));
    for (const k of Object.keys(guests)) delete guests[k];
    const mk = (fullName: string, email: string, role: Role) => User.create({ fullName, email, role, isActive: true });
    org = await mk('Org', 'org@x.com', Role.ORGANIZER);
    other = await mk('Other', 'other@x.com', Role.ORGANIZER);
    staff = await mk('Staff', 'staff@x.com', Role.SYSTEM_USER);
    admin = await mk('Admin', 'admin@x.com', Role.ADMIN);
    tOrg = generateAccessToken(String(org._id), org.role);
    tOther = generateAccessToken(String(other._id), other.role);
    tStaff = generateAccessToken(String(staff._id), staff.role);
    tAdmin = generateAccessToken(String(admin._id), admin.role);
    event = await Event.create({
      organizerId: org._id, title: 'Summit', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, contactNumber: '123456789',
      schedule: { start: new Date(Date.now() - HOUR), end: new Date(Date.now() + 4 * HOUR) }, status: EventStatus.PUBLISHED,
      rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: false }
    });
    await Session.create({ eventId: event._id, name: 'Main', schedule: event.schedule, accessControl: AccessControl.NO_RESTRICTION, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    await SystemUserAssignment.create({ userId: staff._id, eventId: event._id, sessionIds: [], assignedBy: org._id });
    await invite('anna', 'Anna', { channel: 'EMAIL' });
    await invite('ben', 'Ben', { channel: 'BOTH' });
    await invite('wes', 'Wes', { channel: 'WHATSAPP' });
    await invite('nora', 'Nora', { issued: false }); // never sent: no pass
    emailSpy = jest.spyOn(emailProvider, 'sendEmail').mockResolvedValue(true as any);
    waSpy = jest.spyOn(whatsappService, 'sendPassWhatsApp').mockResolvedValue({ messageId: 'wamid.x' });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const revoke = (key: string, body: Record<string, unknown> = { category: 'LOST_OR_COMPROMISED' }, who = tOrg) => request(app).post(`/api/v1/invitees/${guests[key].inv._id}/revoke`).set(auth(who)).send(body);
  const replace = (key: string, body: Record<string, unknown> = { category: 'ATTENDEE_REQUESTED_REPLACEMENT' }, who = tOrg) => request(app).post(`/api/v1/invitees/${guests[key].inv._id}/replace`).set(auth(who)).send(body);
  const scan = (raw: string, who = tOrg) => request(app).post('/api/v1/checkins/scan').set(auth(who)).send({ qrCode: raw, eventId: String(event._id) });
  const fresh = (key: string): Promise<any> => Invitee.findById(guests[key].inv._id).select('+qrTokenCipher').lean() as any;
  const listStatus = async (key: string) => (await request(app).get(`/api/v1/events/${event._id}/invitees?limit=50`).set(auth(tOrg))).body.data.find((i: any) => i._id === String(guests[key].inv._id));
  const history = async (key?: string, who = tOrg) => request(app).get(`/api/v1/events/${event._id}/invitees/credential-events${key ? `?inviteeId=${guests[key].inv._id}` : ''}`).set(auth(who));

  // ───────── policy ─────────
  describe('rules (pure)', () => {
    it('reason categories: mandatory category, optional note, Other needs a note, withdrawn is not a reason to replace', () => {
      expect(validateReason('REVOKE', undefined, '')).toMatch(/Choose a reason/);
      expect(validateReason('REVOKE', 'NOPE', '')).toMatch(/Choose a reason/);
      expect(validateReason('REVOKE', 'LOST_OR_COMPROMISED', '')).toBeNull();
      expect(validateReason('REVOKE', 'OTHER', '   ')).toMatch(/Explain/);
      expect(validateReason('REVOKE', 'OTHER', 'because')).toBeNull();
      expect(validateReason('REVOKE', 'ACCESS_WITHDRAWN', '')).toBeNull();
      expect(validateReason('REPLACE', 'ACCESS_WITHDRAWN', 'x')).toMatch(/not a reason/);
      expect(validateReason('REVOKE', 'LOST_OR_COMPROMISED', 'x'.repeat(501))).toMatch(/at most/);
    });
    it('replacement after revocation: allowed / prohibited / review', () => {
      for (const c of ['LOST_OR_COMPROMISED', 'FORWARDED_OR_SHARED', 'DUPLICATE_OR_INCORRECT', 'ATTENDEE_REQUESTED_REPLACEMENT']) expect(replacementAfterRevocation(c)).toBe('ALLOWED');
      expect(replacementAfterRevocation('ACCESS_WITHDRAWN')).toBe('PROHIBITED');
      expect(replacementAfterRevocation('OTHER')).toBe('REVIEW');
    });
    it('status is separate from delivery and RSVP, and "Replaced" is never a current status', () => {
      const open = { status: 'PUBLISHED', schedule: { start: new Date(Date.now() - HOUR), end: new Date(Date.now() + HOUR) } };
      expect(credentialStatus({}, open).status).toBe('NOT_ISSUED');
      expect(credentialStatus({ qrTokenHash: 'h' }, open).status).toBe('ACTIVE');
      expect(credentialStatus({ qrTokenHash: 'h', credentialRevokedAt: new Date() }, open).status).toBe('REVOKED');
      expect(credentialStatus({ qrTokenHash: 'h' }, { ...open, schedule: { start: new Date(Date.now() - 3 * HOUR), end: new Date(Date.now() - HOUR) } })).toMatchObject({ status: 'EXPIRED', reason: 'ADMISSION_CLOSED' });
      expect(credentialStatus({ qrTokenHash: 'h' }, { ...open, status: 'COMPLETED' })).toMatchObject({ status: 'EXPIRED', reason: 'EVENT_COMPLETED' });
      expect(credentialStatus({ qrTokenHash: 'h' }, { ...open, status: 'CANCELLED' })).toMatchObject({ status: 'EXPIRED', reason: 'EVENT_CANCELLED' });
      expect(['NOT_ISSUED', 'ACTIVE', 'REVOKED', 'EXPIRED']).not.toContain('REPLACED');
    });
  });

  // ───────── status in the guest list ─────────
  describe('access pass status in the guest list', () => {
    it('shows Active / Not issued independently of delivery and RSVP', async () => {
      expect((await listStatus('anna')).credentialStatus).toBe('ACTIVE');
      expect((await listStatus('nora')).credentialStatus).toBe('NOT_ISSUED');
      await Invitee.updateOne({ _id: guests.anna.inv._id }, { rsvpStatus: RsvpStatus.DECLINED });
      const row = await listStatus('anna');
      expect(row.credentialStatus).toBe('ACTIVE');
      expect(row.rsvpStatus).toBe('DECLINED');
    });
    it('shows Expired once the admission window has closed', async () => {
      await Event.updateOne({ _id: event._id }, { schedule: { start: new Date(Date.now() - 3 * HOUR), end: new Date(Date.now() - HOUR) } });
      expect((await listStatus('anna')).credentialStatus).toBe('EXPIRED');
    });
  });

  // ───────── revoke ─────────
  describe('Revoke Access Pass', () => {
    it('the owner revokes; an admin may; another organizer, staff and anonymous may not', async () => {
      expect((await revoke('anna', { category: 'LOST_OR_COMPROMISED' }, tOther)).status).toBe(404);
      expect((await revoke('anna', { category: 'LOST_OR_COMPROMISED' }, tStaff)).status).toBe(403);
      expect((await request(app).post(`/api/v1/invitees/${guests.anna.inv._id}/revoke`).send({ category: 'OTHER', note: 'x' })).status).toBe(401);
      expect((await fresh('anna')).credentialRevokedAt).toBeFalsy();
      expect((await revoke('anna', { category: 'LOST_OR_COMPROMISED' })).status).toBe(200);
      expect((await revoke('ben', { category: 'ACCESS_WITHDRAWN' }, tAdmin)).status).toBe(200);
      await settle();
    });

    it('needs a reason category; the note is optional, except for Other', async () => {
      expect((await revoke('anna', {})).status).toBe(400);
      expect((await revoke('anna', { category: 'MADE_UP' })).status).toBe(400);
      const noText = await revoke('anna', { category: 'OTHER' });
      expect(noText.status).toBe(400);
      expect(noText.body.message).toMatch(/Explain/);
      expect((await revoke('anna', { category: 'OTHER', note: 'Dispute with the organiser' })).status).toBe(200);
      expect((await revoke('ben', { category: 'FORWARDED_OR_SHARED' })).status).toBe(200); // no note needed
      await settle();
    });

    it('the pass stops working at once, RSVP and attendance are unchanged, the status shows Revoked', async () => {
      const before = await scan(guests.anna.raw);
      expect(before.status).toBe(201);
      await revoke('ben');
      await settle();
      const res = await scan(guests.ben.raw);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('CREDENTIAL_REVOKED');
      const row = await listStatus('ben');
      expect(row.credentialStatus).toBe('REVOKED');
      expect(row.rsvpStatus).toBe('ACCEPTED');
      expect(row.credentialRevocation.category).toBe('LOST_OR_COMPROMISED');
      expect(await CheckIn.countDocuments({ inviteeId: guests.anna.inv._id })).toBe(1);
    });

    it('is refused for a guest with no pass, and for cancelled or completed events', async () => {
      const res = await revoke('nora');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_ISSUED');
      await Event.updateOne({ _id: event._id }, { status: EventStatus.COMPLETED });
      expect((await revoke('anna')).body.code).toBe('EVENT_NOT_ACTIVE');
      await Event.updateOne({ _id: event._id }, { status: EventStatus.CANCELLED });
      expect((await revoke('anna')).status).toBe(409);
      expect((await fresh('anna')).credentialRevokedAt).toBeFalsy();
    });

    it('notifies the guest on the channels their invitation succeeded on, and says nothing about the reason', async () => {
      await revoke('ben', { category: 'OTHER', note: 'internal dispute details' });
      await settle();
      expect(emailSpy).toHaveBeenCalledTimes(1);
      const [to, subject, html] = emailSpy.mock.calls[0];
      expect(to).toBe('ben@x.com');
      expect(subject).toMatch(/withdrawn/i);
      expect(html).toMatch(/no longer valid/);
      expect(html).not.toMatch(/dispute|OTHER|LOST|reason/i);
      expect(html).not.toContain(guests.ben.raw);
      expect(waSpy).toHaveBeenCalledTimes(1); // Ben was invited on both channels
      expect(waSpy.mock.calls[0][0]).toMatchObject({ kind: 'REVOKED', inviteeName: 'Ben' });
      const n: any = await PassNotice.findOne({ inviteeId: guests.ben.inv._id }).lean();
      expect(n).toMatchObject({ kind: 'REVOKED', email: { status: 'SENT' }, whatsapp: { status: 'SENT' } });
    });

    it('an email-only guest gets no WhatsApp; a WhatsApp-only guest gets no email', async () => {
      await revoke('anna'); await revoke('wes');
      await settle();
      expect(emailSpy.mock.calls.map((c) => c[0])).toEqual(['anna@x.com']);
      expect(waSpy.mock.calls.map((c) => c[0].inviteeName)).toEqual(['Wes']);
    });

    it('is idempotent: a second or simultaneous revoke records and sends once', async () => {
      const results = await Promise.all([revoke('anna'), revoke('anna'), revoke('anna', { category: 'ACCESS_WITHDRAWN' })]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      await settle();
      expect(await CredentialEvent.countDocuments({ inviteeId: guests.anna.inv._id, type: 'REVOKED' })).toBe(1);
      expect(await PassNotice.countDocuments({ inviteeId: guests.anna.inv._id })).toBe(1);
      expect(emailSpy).toHaveBeenCalledTimes(1);
    });

    it('with WhatsApp unconfigured the revocation stands and the channel is reported unavailable', async () => {
      waSpy.mockRestore(); // real sender: no template / credentials in tests
      await revoke('wes');
      await settle();
      const n: any = await PassNotice.findOne({ inviteeId: guests.wes.inv._id }).lean();
      expect(n.whatsapp.status).toBe('UNAVAILABLE');
      expect(n.whatsapp.failureReason).toMatch(/not (configured|set up)/i);
      expect((await listStatus('wes')).credentialStatus).toBe('REVOKED');
    });

    it('is audited (category, not the free text) and refused when the audit record cannot be written', async () => {
      await revoke('anna', { category: 'OTHER', note: 'private details' });
      await settle();
      const row: any = await auditRow('CREDENTIAL_REVOKE');
      expect(row.status).toBe('SUCCESS');
      expect(String(row.actorId)).toBe(String(org._id));
      expect(String(row.organizerId)).toBe(String(org._id));
      expect(JSON.stringify(row.toObject())).not.toMatch(/private details|@x\.com|98765\d{5}/);
      expect(row.metadata.category).toBe('OTHER');
      jest.spyOn(auditLogRepository, 'create').mockRejectedValue(new Error('down'));
      const res = await revoke('ben');
      expect(res.status).toBe(503);
      expect((await fresh('ben')).credentialRevokedAt).toBeFalsy();
    });

    it('a resend does not re-issue a revoked pass', async () => {
      await revoke('anna');
      await settle();
      const inv: any = await Invitation.findOne({ inviteeId: guests.anna.inv._id });
      emailSpy.mockClear();
      const res = await request(app).post(`/api/v1/events/${event._id}/invitations/resend`).set(auth(tOrg)).send({ invitationIds: [String(inv._id)] });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toMatch(/Pass revoked/);
      expect(emailSpy).not.toHaveBeenCalled();
      expect((await fresh('anna')).qrTokenHash).toBe(hashToken(guests.anna.raw));
    });
  });

  // ───────── replace ─────────
  describe('Replace Access Pass', () => {
    it('authorization: owner and admin only', async () => {
      expect((await replace('anna', undefined, tOther)).status).toBe(404);
      expect((await replace('anna', undefined, tStaff)).status).toBe(403);
      expect((await request(app).post(`/api/v1/invitees/${guests.anna.inv._id}/replace`).send({ category: 'OTHER', note: 'x' })).status).toBe(401);
      expect((await fresh('anna')).qrTokenHash).toBe(hashToken(guests.anna.raw));
      expect((await replace('anna')).status).toBe(200);
      expect((await replace('ben', { category: 'FORWARDED_OR_SHARED' }, tAdmin)).status).toBe(200);
      await settle();
    });

    it('reason rules: category required, Other needs text, "access withdrawn" is not a reason to replace', async () => {
      expect((await replace('anna', {})).status).toBe(400);
      expect((await replace('anna', { category: 'OTHER' })).status).toBe(400);
      expect((await replace('anna', { category: 'ACCESS_WITHDRAWN' })).status).toBe(400);
      expect((await replace('anna', { category: 'OTHER', note: 'Printed with the wrong name' })).status).toBe(200);
      await settle();
    });

    it('issues a new Active pass and invalidates the old one at once; RSVP unchanged', async () => {
      const res = await replace('anna', { category: 'LOST_OR_COMPROMISED' });
      expect(res.status).toBe(200);
      expect(res.body.data.credentialStatus).toBe('ACTIVE');
      expect(res.body.data.version).toBe(2);
      const now = await fresh('anna');
      expect(now.qrTokenHash).not.toBe(hashToken(guests.anna.raw));
      expect(now.credentialVersion).toBe(2);
      expect(now.rsvpStatus).toBe(RsvpStatus.ACCEPTED);
      const old = await scan(guests.anna.raw);
      expect(old.status).toBe(410);
      expect(old.body.code).toBe('QR_TOKEN_SUPERSEDED');
      await settle();
      const newRaw = (await import('../src/utils/tokenCipher')).decryptToken(now.qrTokenCipher)!;
      expect(hashToken(newRaw)).toBe(now.qrTokenHash);
      expect((await scan(newRaw)).status).toBe(201);
      expect((await listStatus('anna')).credentialStatus).toBe('ACTIVE');
    });

    it('always notifies: new card by email with the new link, never the old token; WhatsApp where the invitation used it', async () => {
      await replace('ben');
      await settle();
      const now = await fresh('ben');
      const newRaw = (await import('../src/utils/tokenCipher')).decryptToken(now.qrTokenCipher)!;
      expect(emailSpy).toHaveBeenCalledTimes(1);
      const [to, subject, html, attachments] = emailSpy.mock.calls[0];
      expect(to).toBe('ben@x.com');
      expect(subject).toMatch(/new access pass/i);
      expect(html).toContain(newRaw);
      expect(html).not.toContain(guests.ben.raw);
      expect(html).not.toMatch(/ATTENDEE_REQUESTED|reason/i);
      expect(attachments[0].content.length).toBeGreaterThan(1000); // the card image
      expect(waSpy).toHaveBeenCalledTimes(1);
      expect(waSpy.mock.calls[0][0]).toMatchObject({ kind: 'REPLACED', inviteeName: 'Ben' });
      expect(Buffer.isBuffer(waSpy.mock.calls[0][0].cardBuffer)).toBe(true);
    });

    it('there is no silent replacement: a guest no earlier invitation reached cannot be replaced, and nothing changes', async () => {
      await Invitation.deleteMany({ inviteeId: guests.anna.inv._id });
      const res = await replace('anna');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_DELIVERY_CHANNEL');
      expect((await fresh('anna')).qrTokenHash).toBe(hashToken(guests.anna.raw));
      expect(emailSpy).not.toHaveBeenCalled();
    });

    it('is refused without a pass, for non-published events, and once the admission window has closed', async () => {
      expect((await replace('nora')).body.code).toBe('NOT_ISSUED');
      await Event.updateOne({ _id: event._id }, { schedule: { start: new Date(Date.now() - 3 * HOUR), end: new Date(Date.now() - HOUR) } });
      expect((await replace('anna')).body.code).toBe('CREDENTIAL_EXPIRED');
      await Event.updateOne({ _id: event._id }, { schedule: { start: new Date(Date.now() - HOUR), end: new Date(Date.now() + HOUR) }, status: EventStatus.CANCELLED });
      expect((await replace('anna')).body.code).toBe('EVENT_NOT_ACTIVE');
      expect((await fresh('anna')).qrTokenHash).toBe(hashToken(guests.anna.raw));
    });

    it('is atomic: if the new pass cannot be prepared, the old pass stays valid', async () => {
      jest.spyOn(invitationService, 'renderPassCard').mockRejectedValue(new Error('renderer down'));
      const res = await replace('anna');
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('CARD_RENDER_FAILED');
      expect((await fresh('anna')).qrTokenHash).toBe(hashToken(guests.anna.raw));
      expect((await scan(guests.anna.raw)).status).toBe(201);
      expect(await CredentialEvent.countDocuments({ inviteeId: guests.anna.inv._id, type: 'REPLACED' })).toBe(0);
      expect(await PassNotice.countDocuments()).toBe(0);
    });

    it('is atomic: if recording the change fails after the swap, the swap is undone and the old pass stays valid', async () => {
      const real = CredentialEvent.create.bind(CredentialEvent) as any;
      jest.spyOn(CredentialEvent, 'create').mockImplementation(((...a: any[]) => { throw new Error('history store down'); }) as any);
      const res = await replace('anna');
      expect(res.status).toBe(500);
      (CredentialEvent.create as any).mockRestore?.();
      void real;
      const now = await fresh('anna');
      expect(now.qrTokenHash).toBe(hashToken(guests.anna.raw));
      expect(now.credentialVersion).toBe(1);
      expect((await scan(guests.anna.raw)).status).toBe(201);
      expect(await PassNotice.countDocuments()).toBe(0);
      expect(emailSpy).not.toHaveBeenCalled();
    });

    it('two replacements at once produce exactly one new pass', async () => {
      const results = await Promise.all([replace('anna'), replace('anna', { category: 'FORWARDED_OR_SHARED' })]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe('CONFLICT');
      await settle();
      expect((await fresh('anna')).credentialVersion).toBe(2);
      expect(await CredentialEvent.countDocuments({ inviteeId: guests.anna.inv._id, type: 'REPLACED' })).toBe(1);
      expect(await PassNotice.countDocuments({ inviteeId: guests.anna.inv._id })).toBe(1);
      expect(emailSpy).toHaveBeenCalledTimes(1);
    });

    it('a second replacement supersedes the first new pass too', async () => {
      await replace('anna'); await settle();
      const v2 = (await import('../src/utils/tokenCipher')).decryptToken((await fresh('anna')).qrTokenCipher)!;
      await replace('anna'); await settle();
      expect((await fresh('anna')).credentialVersion).toBe(3);
      expect((await scan(v2)).body.code).toBe('QR_TOKEN_SUPERSEDED');
      expect((await scan(guests.anna.raw)).body.code).toBe('QR_TOKEN_SUPERSEDED');
    });

    it('a failed message does not undo the replacement and can be retried safely; unknown outcomes need explicit acknowledgement', async () => {
      emailSpy.mockRejectedValueOnce(new Error('FAILED_TO_SEND_EMAIL'));
      expect((await replace('anna')).status).toBe(200);
      await settle();
      let n: any = await PassNotice.findOne({ inviteeId: guests.anna.inv._id }).lean();
      expect(n.email.status).toBe('FAILED');
      expect((await fresh('anna')).credentialVersion).toBe(2);
      const retry = await request(app).post(`/api/v1/events/${event._id}/invitees/pass-notices/retry`).set(auth(tOrg)).send({});
      expect(retry.status).toBe(200);
      n = await PassNotice.findOne({ inviteeId: guests.anna.inv._id }).lean();
      expect(n.email.status).toBe('SENT');
      const sent = emailSpy.mock.calls.length;
      await request(app).post(`/api/v1/events/${event._id}/invitees/pass-notices/retry`).set(auth(tOrg)).send({});
      expect(emailSpy.mock.calls.length).toBe(sent); // nothing left to send

      // unknown: not retried without the acknowledgement
      await PassNotice.updateOne({ _id: n._id }, { $set: { 'email.status': 'SENDING', 'email.lastAttemptAt': new Date(Date.now() - HOUR) } });
      await passNoticeService.settleStaleSending();
      expect(((await PassNotice.findById(n._id).lean()) as any).email.status).toBe('UNKNOWN');
      await request(app).post(`/api/v1/events/${event._id}/invitees/pass-notices/retry`).set(auth(tOrg)).send({});
      expect(emailSpy.mock.calls.length).toBe(sent);
      await request(app).post(`/api/v1/events/${event._id}/invitees/pass-notices/retry`).set(auth(tOrg)).send({ includeUnknown: true });
      expect(emailSpy.mock.calls.length).toBe(sent + 1);
    });

    it('is audited and fails closed', async () => {
      await replace('anna', { category: 'OTHER', note: 'private details' });
      await settle();
      const row: any = await auditRow('CREDENTIAL_REPLACE');
      expect(row.status).toBe('SUCCESS');
      expect(JSON.stringify(row.toObject())).not.toMatch(/private details|@x\.com/);
      jest.spyOn(auditLogRepository, 'create').mockRejectedValue(new Error('down'));
      expect((await replace('ben')).status).toBe(503);
      expect((await fresh('ben')).qrTokenHash).toBe(hashToken(guests.ben.raw));
    });
  });

  // ───────── replace after revoke ─────────
  describe('replacing a revoked pass', () => {
    it.each(['LOST_OR_COMPROMISED', 'FORWARDED_OR_SHARED', 'DUPLICATE_OR_INCORRECT', 'ATTENDEE_REQUESTED_REPLACEMENT'])('after "%s" it is allowed: a new Active pass, with the revocation kept in history', async (category) => {
      await revoke('anna', { category, note: 'original note' });
      await settle();
      const res = await replace('anna', { category: 'ATTENDEE_REQUESTED_REPLACEMENT' });
      expect(res.status).toBe(200);
      await settle();
      const now = await fresh('anna');
      expect(now.credentialRevokedAt).toBeFalsy();
      expect(now.credentialRevocation).toBeFalsy();
      expect((await listStatus('anna')).credentialStatus).toBe('ACTIVE');
      expect(now.rsvpStatus).toBe(RsvpStatus.ACCEPTED);
      const h = (await history('anna')).body.data as any[];
      const types = h.map((e) => e.type);
      expect(types).toEqual(['REPLACED', 'REVOKED', 'ISSUED']); // newest first; nothing edited or removed
      const revoked = h.find((e) => e.type === 'REVOKED');
      expect(revoked.reasonCategory).toBe(category);
      expect(revoked.note).toBe('original note');
      expect(h.find((e) => e.type === 'REPLACED').previousVersion).toBe(1);
    });

    it('"access withdrawn" cannot be replaced through the ordinary action', async () => {
      await revoke('anna', { category: 'ACCESS_WITHDRAWN' });
      const res = await replace('anna');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REPLACEMENT_NOT_ALLOWED');
      expect((await listStatus('anna')).credentialStatus).toBe('REVOKED');
      expect(await CredentialEvent.countDocuments({ inviteeId: guests.anna.inv._id, type: 'REPLACED' })).toBe(0);
    });

    it('"other" needs an explicit review confirmation first', async () => {
      await revoke('anna', { category: 'OTHER', note: 'unclear case' });
      await settle();
      const without = await replace('anna');
      expect(without.status).toBe(409);
      expect(without.body.code).toBe('REVIEW_REQUIRED');
      expect((await listStatus('anna')).credentialStatus).toBe('REVOKED');
      const withReview = await replace('anna', { category: 'ATTENDEE_REQUESTED_REPLACEMENT', reviewConfirmed: true });
      expect(withReview.status).toBe(200);
      await settle();
      const h = (await history('anna')).body.data as any[];
      expect(h.find((e) => e.type === 'REPLACED').reviewConfirmed).toBe(true);
      expect(h.find((e) => e.type === 'REVOKED').reasonCategory).toBe('OTHER');
    });

    it('only while the guest remains eligible for admission', async () => {
      await revoke('anna', { category: 'LOST_OR_COMPROMISED' });
      await settle();
      await Invitee.updateOne({ _id: guests.anna.inv._id }, { rsvpStatus: RsvpStatus.DECLINED }); // the event does not admit declined guests
      const res = await replace('anna');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_ELIGIBLE');
      expect((await listStatus('anna')).credentialStatus).toBe('REVOKED');
    });
  });

  // ───────── history, public page ─────────
  describe('history and the invitation page', () => {
    it('history is available to the owner and admin only and never exposes tokens', async () => {
      await replace('anna'); await settle();
      expect((await history(undefined, tOther)).status).toBe(404);
      expect((await history(undefined, tStaff)).status).toBe(403);
      const res = await history(undefined, tAdmin);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${guests.anna.raw}|${hashToken(guests.anna.raw)}|tokenHash`));
      const row = (res.body.data as any[]).find((e) => e.type === 'REPLACED');
      expect(row).toMatchObject({ inviteeName: 'Anna', reasonCategory: 'ATTENDEE_REQUESTED_REPLACEMENT', version: 2 });
      expect(row.notice.email.status).toBe('SENT');
    });

    it('send and resend record the issue and re-issue in the history', async () => {
      await Invitee.updateOne({ _id: guests.nora.inv._id }, { email: 'nora@x.com' });
      const send = await request(app).post(`/api/v1/events/${event._id}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: [String(guests.nora.inv._id)], channel: 'EMAIL' });
      expect(send.status).toBe(200);
      let h = (await history('nora')).body.data as any[];
      expect(h.map((e) => e.type)).toEqual(['ISSUED']);
      const inv: any = await Invitation.findOne({ inviteeId: guests.nora.inv._id });
      await request(app).post(`/api/v1/events/${event._id}/invitations/resend`).set(auth(tOrg)).send({ invitationIds: [String(inv._id)] });
      h = (await history('nora')).body.data as any[];
      expect(h.map((e) => e.type)).toEqual(['REPLACED', 'ISSUED']);
      expect(h[0].source).toBe('RESEND');
      expect((await listStatus('nora')).credentialStatus).toBe('ACTIVE');
    });

    it('the current link shows the new pass as Active; the old link says it was replaced and reveals nothing new', async () => {
      await replace('anna'); await settle();
      const now = await fresh('anna');
      const newRaw = (await import('../src/utils/tokenCipher')).decryptToken(now.qrTokenCipher)!;
      const cur = await request(app).get(`/api/v1/public/invitations/${newRaw}`);
      expect(cur.status).toBe(200);
      expect(cur.body.data.credential.status).toBe('ACTIVE');
      expect((await request(app).get(`/api/v1/public/invitations/${newRaw}/card`)).headers['content-type']).toContain('image/png');
      const old = await request(app).get(`/api/v1/public/invitations/${guests.anna.raw}`);
      expect(old.status).toBe(200);
      expect(old.body.data.credential.status).toBe('REPLACED');
      expect(JSON.stringify(old.body)).not.toContain(newRaw);
      expect(JSON.stringify(old.body)).not.toContain(now.qrTokenHash);
      const oldCard = await request(app).get(`/api/v1/public/invitations/${guests.anna.raw}/card`);
      expect(oldCard.status).toBe(410);
      expect(oldCard.body.code).toBe('CREDENTIAL_REPLACED');
      expect((await request(app).get(`/api/v1/public/invitations/${generateSecureToken()}`)).status).toBe(404);
    });

    it('a revoked pass: the page says so, hides the card, and RSVP is untouched', async () => {
      await revoke('anna'); await settle();
      const page = await request(app).get(`/api/v1/public/invitations/${guests.anna.raw}`);
      expect(page.body.data.credential.status).toBe('REVOKED');
      expect(page.body.data.invitee.rsvpStatus).toBe('ACCEPTED');
      const card = await request(app).get(`/api/v1/public/invitations/${guests.anna.raw}/card`);
      expect(card.status).toBe(410);
      expect(card.body.code).toBe('CREDENTIAL_REVOKED');
    });
  });
});
