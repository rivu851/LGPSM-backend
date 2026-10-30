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
import { CancellationNotice } from '../src/models/CancellationNotice';
import { cancellationNoticeService } from '../src/services/cancellationNotice.service';
import { auditLogRepository } from '../src/repositories/auditLog.repository';
import { whatsappService } from '../src/services/whatsapp.service';
import * as emailProvider from '../src/utils/email.provider';
import { clock } from '../src/utils/clock';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

// every guest of an event has their own phone number (the database allows one active guest per number)
let mobileSeq = 0;
const uniqueMobile = () => `98765${String(43210 + ++mobileSeq)}`;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const START = new Date('2026-10-31T04:30:00.000Z');
const END = new Date('2026-10-31T11:30:00.000Z');
const DURING = new Date('2026-10-31T06:00:00.000Z');

// notices are sent after the response; wait until none is waiting or in flight
async function settle(eventId: unknown, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const open = await CancellationNotice.countDocuments({ eventId: eventId as any, $or: [{ 'email.status': { $in: ['PENDING', 'SENDING'] } }, { 'whatsapp.status': { $in: ['PENDING', 'SENDING'] } }] });
    if (!open) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('P0.3 — event cancellation lifecycle', () => {
  let mongo: MongoMemoryServer;
  let org: any, other: any, staff: any, admin: any;
  let tOrg: string, tOther: string, tStaff: string, tAdmin: string;
  let event: any, session: any;
  const guests: Record<string, { inv: any; raw: string }> = {};
  let emailSpy: jest.SpyInstance, waSpy: jest.SpyInstance;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([CheckIn, CancellationNotice, AuditLog].map((m: any) => m.syncIndexes()));
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const invite = async (key: string, name: string, over: Record<string, unknown>, delivery?: Record<string, unknown>) => {
    const raw = generateSecureToken();
    const inv = await Invitee.create({ eventId: event._id, name, email: `${key}@x.com`, mobile: uniqueMobile(), invitationStatus: InvitationStatus.SENT, rsvpStatus: RsvpStatus.PENDING, qrTokenHash: hashToken(raw), sessionAccess: [], ...over });
    if (delivery) await Invitation.create({ eventId: event._id, inviteeId: inv._id, tokenHash: hashToken(raw), ...delivery });
    guests[key] = { inv, raw };
  };

  beforeEach(async () => {
    await Promise.all([User, Event, Session, Invitee, Invitation, SystemUserAssignment, CheckIn, AuditLog, CancellationNotice].map((m: any) => m.deleteMany({})));
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
      organizerId: org._id, title: 'Summit', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL,
      schedule: { start: START, end: END }, status: EventStatus.PUBLISHED, contactNumber: '123456789',
      rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: true }
    });
    session = await Session.create({ eventId: event._id, name: 'Main', schedule: { start: START, end: END }, accessControl: AccessControl.NO_RESTRICTION, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    await SystemUserAssignment.create({ userId: staff._id, eventId: event._id, sessionIds: [], assignedBy: org._id });

    const sent = { status: InvitationDeliveryStatus.SENT };
    await invite('accepted', 'Alice', { rsvpStatus: RsvpStatus.ACCEPTED }, { ...sent, channel: DeliveryChannel.EMAIL, emailStatus: InvitationDeliveryStatus.SENT });
    await invite('declined', 'Dan', { rsvpStatus: RsvpStatus.DECLINED }, { ...sent, channel: DeliveryChannel.EMAIL, emailStatus: InvitationDeliveryStatus.SENT });
    await invite('pending', 'Pia', { rsvpStatus: RsvpStatus.PENDING }, { ...sent, channel: DeliveryChannel.BOTH, emailStatus: InvitationDeliveryStatus.SENT, whatsappStatus: InvitationDeliveryStatus.SENT });
    await invite('waonly', 'Wes', {}, { ...sent, channel: DeliveryChannel.WHATSAPP, whatsappStatus: InvitationDeliveryStatus.SENT });
    await invite('legacy', 'Lee', {}, { ...sent, channel: DeliveryChannel.EMAIL }); // an older record without per-channel status
    await invite('unsent', 'Uma', { invitationStatus: InvitationStatus.PENDING }); // only on the list
    await invite('failed', 'Fay', { invitationStatus: InvitationStatus.FAILED }, { status: InvitationDeliveryStatus.FAILED, channel: DeliveryChannel.EMAIL, emailStatus: InvitationDeliveryStatus.FAILED });
    await invite('mixed', 'Max', {}, { status: InvitationDeliveryStatus.SENT, channel: DeliveryChannel.BOTH, emailStatus: InvitationDeliveryStatus.FAILED, whatsappStatus: InvitationDeliveryStatus.SENT });

    emailSpy = jest.spyOn(emailProvider, 'sendEmail').mockResolvedValue(true as any);
    waSpy = jest.spyOn(whatsappService, 'sendCancellationWhatsApp').mockResolvedValue({ messageId: 'wamid.test' });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const cancel = (who = tOrg, body: Record<string, unknown> = {}, id = event._id) => request(app).post(`/api/v1/events/${id}/cancel`).set(auth(who)).send(body);
  const sentTo = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => c[0]).sort();

  // ───────────── authorization & state ─────────────
  describe('who can cancel, and from which state', () => {
    it('the owning organizer cancels a published event; status and metadata are stored', async () => {
      const res = await cancel(tOrg, { reason: 'Venue unavailable' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');
      const ev: any = await Event.findById(event._id);
      expect(ev.status).toBe(EventStatus.CANCELLED);
      expect(ev.cancelledAt).toBeInstanceOf(Date);
      expect(String(ev.cancelledBy)).toBe(String(org._id));
      expect(ev.cancelledByRole).toBe('ORGANIZER');
      expect(ev.cancellationReason).toBe('Venue unavailable');
      await settle(event._id);
    });

    it('an administrator may cancel any event; another organizer and staff may not', async () => {
      expect((await cancel(tOther)).status).toBe(404);
      expect((await cancel(tStaff)).status).toBe(403);
      expect((await request(app).post(`/api/v1/events/${event._id}/cancel`)).status).toBe(401);
      expect((await Event.findById(event._id))?.status).toBe(EventStatus.PUBLISHED);
      expect((await cancel(tAdmin)).status).toBe(200);
      await settle(event._id);
    });

    it('a draft event can be cancelled (it has no invitations to notify)', async () => {
      await Event.updateOne({ _id: event._id }, { status: EventStatus.DRAFT });
      await Invitation.deleteMany({});
      const res = await cancel();
      expect(res.status).toBe(200);
      expect(res.body.data.notices.eligible).toBe(0);
      expect(emailSpy).not.toHaveBeenCalled();
    });

    it('a completed or closed event cannot be cancelled', async () => {
      await request(app).post(`/api/v1/events/${event._id}/close`).set(auth(tOrg));
      const res = await cancel();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_TRANSITION');
      expect((await Event.findById(event._id))?.status).toBe(EventStatus.COMPLETED);
      expect(await CancellationNotice.countDocuments()).toBe(0);
    });

    it('DELETE /events/:id is the same cancellation and never deletes anything', async () => {
      const res = await request(app).delete(`/api/v1/events/${event._id}`).set(auth(tOrg));
      expect(res.status).toBe(200);
      expect(await Event.countDocuments({ _id: event._id })).toBe(1);
      expect((await Event.findById(event._id))?.status).toBe(EventStatus.CANCELLED);
      await settle(event._id);
    });

    it('a cancelled event cannot be reinstated, reopened, edited, closed or have its window changed', async () => {
      await cancel();
      await settle(event._id);
      const status = async () => (await Event.findById(event._id))?.status;
      await request(app).patch(`/api/v1/events/${event._id}`).set(auth(tOrg)).send({ status: 'PUBLISHED' });
      expect(await status()).toBe(EventStatus.CANCELLED);
      expect((await request(app).patch(`/api/v1/events/${event._id}`).set(auth(tAdmin)).send({ title: 'New' })).body.code).toBe('EVENT_CLOSED');
      expect((await request(app).post(`/api/v1/events/${event._id}/close`).set(auth(tOrg))).status).toBe(409);
      expect((await request(app).patch(`/api/v1/events/${event._id}/admission`).set(auth(tOrg)).send({ opensAt: null })).status).toBe(409);
      for (const path of ['restore', 'reinstate', 'publish', 'reopen']) {
        expect([404, 405]).toContain((await request(app).post(`/api/v1/events/${event._id}/${path}`).set(auth(tAdmin))).status);
      }
      expect(await status()).toBe(EventStatus.CANCELLED);
    });
  });

  // ───────────── notifications ─────────────
  describe('cancellation notices', () => {
    it('go to every guest an invitation was actually sent to, whatever their RSVP, and to nobody else', async () => {
      const res = await cancel();
      expect(res.body.data.notices.eligible).toBe(6); // accepted, declined, pending, wa-only, legacy, mixed
      await settle(event._id);
      expect(sentTo(emailSpy)).toEqual(['accepted@x.com', 'declined@x.com', 'legacy@x.com', 'pending@x.com']);
      expect(waSpy.mock.calls.map((c) => c[0].inviteeName).sort()).toEqual(['Max', 'Pia', 'Wes']); // pending (both channels), wa-only, mixed
      const told = (await CancellationNotice.find({ eventId: event._id })).map((n) => String(n.inviteeId)).sort();
      expect(told).toEqual([guests.accepted, guests.declined, guests.pending, guests.waonly, guests.legacy, guests.mixed].map((g) => String(g.inv._id)).sort());
      for (const k of ['unsent', 'failed']) expect(told).not.toContain(String(guests[k].inv._id));
    });

    it('use only the channels the invitation reached: email-only guests get no WhatsApp, a failed channel is not used', async () => {
      await cancel();
      await settle(event._id);
      const notice = async (k: string): Promise<any> => CancellationNotice.findOne({ inviteeId: guests[k].inv._id }).lean();
      expect(await notice('accepted')).toMatchObject({ email: { status: 'SENT' }, whatsapp: { status: 'NOT_USED' } });
      expect(await notice('waonly')).toMatchObject({ email: { status: 'NOT_USED' }, whatsapp: { status: 'SENT' } });
      expect(await notice('pending')).toMatchObject({ email: { status: 'SENT' }, whatsapp: { status: 'SENT' } });
      expect(await notice('mixed')).toMatchObject({ email: { status: 'NOT_USED' }, whatsapp: { status: 'SENT' } });
    });

    it('never change a guest\'s RSVP status, and never touch their records', async () => {
      const before = (await Invitee.find({ eventId: event._id }).sort({ name: 1 }).lean()).map((i: any) => [i.name, i.rsvpStatus, i.invitationStatus]);
      await cancel();
      await settle(event._id);
      const after = (await Invitee.find({ eventId: event._id }).sort({ name: 1 }).lean()).map((i: any) => [i.name, i.rsvpStatus, i.invitationStatus]);
      expect(after).toEqual(before);
      expect(await Invitation.countDocuments({ eventId: event._id })).toBe(7);
    });

    it('report an unconfigured WhatsApp / email provider honestly as UNAVAILABLE, and never as sent', async () => {
      emailSpy.mockRestore();
      waSpy.mockRestore(); // real senders: no credentials in the test environment
      const res = await cancel();
      expect(res.status).toBe(200);
      await settle(event._id);
      const summary = await request(app).get(`/api/v1/events/${event._id}/cancellation/notices`).set(auth(tOrg));
      expect(summary.body.data.channels.email.SENT).toBe(0);
      expect(summary.body.data.channels.whatsapp.SENT).toBe(0);
      expect(summary.body.data.channels.email.UNAVAILABLE).toBe(4);
      expect(summary.body.data.channels.whatsapp.UNAVAILABLE).toBe(3);
      expect(summary.body.data.problems[0].reason).toMatch(/not (configured|set up)/i);
      expect((await Event.findById(event._id))?.status).toBe(EventStatus.CANCELLED); // the cancellation stands
    });

    it('a provider failure does not undo the cancellation and can be retried without re-sending what went out', async () => {
      emailSpy.mockImplementation(async (to: string) => {
        if (to === 'declined@x.com') throw new Error('FAILED_TO_SEND_EMAIL');
        return true as any;
      });
      await cancel();
      await settle(event._id);
      expect((await Event.findById(event._id))?.status).toBe(EventStatus.CANCELLED);
      let summary = await request(app).get(`/api/v1/events/${event._id}/cancellation/notices`).set(auth(tOrg));
      expect(summary.body.data.channels.email).toMatchObject({ SENT: 3, FAILED: 1 });
      expect(summary.body.data.problems).toHaveLength(1);
      expect(summary.body.data.problems[0]).toMatchObject({ name: 'Dan', channel: 'email', status: 'FAILED' });
      expect(await AuditLog.countDocuments({ action: 'EVENT_CANCEL_NOTIFICATIONS', status: 'FAILED' })).toBeGreaterThan(0);

      const callsBefore = emailSpy.mock.calls.length;
      emailSpy.mockResolvedValue(true as any);
      const retry = await request(app).post(`/api/v1/events/${event._id}/cancellation/notices/retry`).set(auth(tOrg));
      expect(retry.status).toBe(200);
      expect(emailSpy.mock.calls.length - callsBefore).toBe(1); // only the failed one
      expect(emailSpy.mock.calls[emailSpy.mock.calls.length - 1][0]).toBe('declined@x.com');
      summary = await request(app).get(`/api/v1/events/${event._id}/cancellation/notices`).set(auth(tOrg));
      expect(summary.body.data.channels.email).toMatchObject({ SENT: 4, FAILED: 0 });

      // a second retry has nothing left to send
      const again = emailSpy.mock.calls.length;
      await request(app).post(`/api/v1/events/${event._id}/cancellation/notices/retry`).set(auth(tOrg));
      expect(emailSpy.mock.calls.length).toBe(again);
    });

    it('repeated and concurrent cancel requests create no duplicate notices or messages', async () => {
      const results = await Promise.all([cancel(), cancel(), cancel(tAdmin)]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => !r.body.data.alreadyCancelled)).toHaveLength(1);
      await settle(event._id);
      await cancel();
      await settle(event._id);
      expect(await CancellationNotice.countDocuments({ eventId: event._id })).toBe(6);
      expect(emailSpy).toHaveBeenCalledTimes(4);
      expect(waSpy).toHaveBeenCalledTimes(3);
    });

    it('workers racing each other (or a retry) never send the same message twice', async () => {
      await cancel();
      await settle(event._id);
      // pretend nothing had gone out: every channel that was SENT is waiting again
      await CancellationNotice.updateMany({ 'email.status': 'SENT' }, { $set: { 'email.status': 'PENDING' } });
      await CancellationNotice.updateMany({ 'whatsapp.status': 'SENT' }, { $set: { 'whatsapp.status': 'PENDING' } });
      emailSpy.mockClear(); waSpy.mockClear();
      await Promise.all([cancellationNoticeService.processEvent(event._id), cancellationNoticeService.processEvent(event._id), cancellationNoticeService.processEvent(event._id, { retry: true })]);
      // three workers, one message per (guest, channel)
      expect(sentTo(emailSpy)).toEqual(['accepted@x.com', 'declined@x.com', 'legacy@x.com', 'pending@x.com']);
      expect(waSpy).toHaveBeenCalledTimes(3);
    });

    it('a notice whose worker died mid-send is UNKNOWN: never resent automatically, and a retry needs an explicit go-ahead', async () => {
      await cancel();
      await settle(event._id);
      await CancellationNotice.updateOne({ inviteeId: guests.accepted.inv._id }, { $set: { 'email.status': 'SENDING', 'email.lastAttemptAt': new Date(Date.now() - 3600e3) } });
      emailSpy.mockClear();
      await cancellationNoticeService.processEvent(event._id);
      expect(emailSpy).not.toHaveBeenCalled();
      const n: any = await CancellationNotice.findOne({ inviteeId: guests.accepted.inv._id }).lean();
      expect(n.email.status).toBe('UNKNOWN'); // not converted into a definite failure
      expect(n.email.failureReason).toMatch(/not known whether/i);
      expect(n.email.failureReason).toMatch(/duplicate/i);

      const summary = await request(app).get(`/api/v1/events/${event._id}/cancellation/notices`).set(auth(tOrg));
      expect(summary.body.data.channels.email.UNKNOWN).toBe(1);
      expect(summary.body.data.problems.find((p: any) => p.status === 'UNKNOWN')).toMatchObject({ name: 'Alice', channel: 'email' });

      // an ordinary retry leaves it alone
      await request(app).post(`/api/v1/events/${event._id}/cancellation/notices/retry`).set(auth(tOrg)).send({});
      expect(emailSpy).not.toHaveBeenCalled();
      expect(((await CancellationNotice.findOne({ inviteeId: guests.accepted.inv._id }).lean()) as any).email.status).toBe('UNKNOWN');

      // only an explicit acknowledgement retries it, once
      await request(app).post(`/api/v1/events/${event._id}/cancellation/notices/retry`).set(auth(tOrg)).send({ includeUnknown: true });
      expect(emailSpy).toHaveBeenCalledTimes(1);
      expect(emailSpy.mock.calls[0][0]).toBe('accepted@x.com');
      expect(((await CancellationNotice.findOne({ inviteeId: guests.accepted.inv._id }).lean()) as any).email.status).toBe('SENT');
      await request(app).post(`/api/v1/events/${event._id}/cancellation/notices/retry`).set(auth(tOrg)).send({ includeUnknown: true });
      expect(emailSpy).toHaveBeenCalledTimes(1);
      const row: any = await AuditLog.findOne({ action: 'EVENT_CANCEL_NOTICES_RETRY', 'metadata.includeUnknown': true });
      expect(row).toBeTruthy();
    });

    it('the sender re-checks the event: nothing is sent for an event that is not cancelled', async () => {
      await CancellationNotice.create({ eventId: event._id, inviteeId: guests.accepted.inv._id, organizerId: org._id, email: { status: 'PENDING', attempts: 0 }, whatsapp: { status: 'NOT_USED', attempts: 0 } });
      const out = await cancellationNoticeService.processEvent(event._id);
      expect(out.attempted).toBe(0);
      expect(emailSpy).not.toHaveBeenCalled();
    });

    it('preview and summary are for the owner or an admin only, and preview matches who would be told', async () => {
      const p = await request(app).get(`/api/v1/events/${event._id}/cancellation/preview`).set(auth(tOrg));
      expect(p.status).toBe(200);
      expect(p.body.data).toMatchObject({ invitedGuests: 6, notInvited: 2, byChannel: { email: 4, whatsapp: 3 } }); // email: accepted, declined, pending, legacy
      for (const path of ['preview', 'notices']) {
        expect((await request(app).get(`/api/v1/events/${event._id}/cancellation/${path}`).set(auth(tOther))).status).toBe(404);
        expect((await request(app).get(`/api/v1/events/${event._id}/cancellation/${path}`).set(auth(tStaff))).status).toBe(403);
      }
      expect((await request(app).post(`/api/v1/events/${event._id}/cancellation/notices/retry`).set(auth(tOrg))).status).toBe(409); // not cancelled
    });

    it('a send still running when the event is cancelled stops, and a guest it already reached is still told', async () => {
      const { invitationService } = await import('../src/services/invitation.service');
      await Promise.all([Invitation, Invitee].map((m: any) => m.deleteMany({})));
      await invite('late1', 'Lia', { invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING });
      await invite('late2', 'Leo', { invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING });
      emailSpy.mockClear();
      let cancelled = false;
      emailSpy.mockImplementation(async (_to: string, subject: string) => {
        if (!cancelled && subject.startsWith('Invitation')) { cancelled = true; await cancel(); } // the cancellation lands in the middle of the send
        return true as any;
      });
      const results: any[] = await invitationService.sendInvitations(String(event._id), { userId: String(org._id), role: 'ORGANIZER' }, [String(guests.late1.inv._id), String(guests.late2.inv._id)], DeliveryChannel.EMAIL);
      await settle(event._id);
      const invitationMails = emailSpy.mock.calls.filter((c) => String(c[1]).startsWith('Invitation'));
      expect(invitationMails.length).toBeLessThanOrEqual(2);
      // every guest an invitation went out to is also told it was cancelled; nobody else is
      const reached = (await Invitation.find({ eventId: event._id, status: 'SENT' }).lean()).map((i: any) => String(i.inviteeId)).sort();
      const told = (await CancellationNotice.find({ eventId: event._id }).lean()).map((n: any) => String(n.inviteeId)).sort();
      expect(told).toEqual(reached);
      expect(results.some((r) => r.status === 'SENT' || r.status === 'SKIPPED')).toBe(true);
    });
  });

  // ───────────── admission, invitations, RSVP ─────────────
  describe('after cancellation', () => {
    beforeEach(() => jest.spyOn(clock, 'now').mockReturnValue(DURING));
    const scan = (raw: string, who = tOrg) => request(app).post('/api/v1/checkins/scan').set(auth(who)).send({ qrCode: raw, eventId: String(event._id) });

    it('every pass of the event is refused by the event status alone — no per-guest update is needed', async () => {
      expect((await scan(guests.accepted.raw)).status).toBe(201);
      await cancel();
      await settle(event._id);
      const res = await scan(guests.declined.raw);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EVENT_CANCELLED');
      expect((await scan(guests.pending.raw, tStaff)).body.code).toBe('EVENT_CANCELLED');
      expect(await Invitee.countDocuments({ eventId: event._id, credentialRevokedAt: { $ne: null } })).toBe(0);
      // the cancelled-event answer is not confused with the other refusals
      await Event.updateOne({ _id: event._id }, { status: EventStatus.COMPLETED });
      expect((await scan(guests.pending.raw)).body.code).toBe('EVENT_COMPLETED');
      await Event.updateOne({ _id: event._id }, { status: EventStatus.PUBLISHED });
      await Invitee.updateOne({ _id: guests.pending.inv._id }, { credentialRevokedAt: new Date() });
      expect((await scan(guests.pending.raw)).body.code).toBe('CREDENTIAL_REVOKED');
      expect((await scan(generateSecureToken())).body.code).toBe('INVALID_QR_TOKEN');
      expect((await scan(guests.accepted.raw)).body.code).toBe('ALREADY_CHECKED_IN');
    });

    it('attendance recorded before the cancellation is kept, and still counted in the report', async () => {
      await scan(guests.accepted.raw);
      await scan(guests.pending.raw);
      const before = await CheckIn.find({}).lean();
      await cancel();
      await settle(event._id);
      expect(await CheckIn.countDocuments()).toBe(2);
      expect((await CheckIn.find({}).lean()).map((c: any) => String(c._id)).sort()).toEqual(before.map((c: any) => String(c._id)).sort());
      const report = await request(app).get(`/api/v1/reports/events/${event._id}`).set(auth(tOrg));
      expect(report.status).toBe(200);
      expect(JSON.stringify(report.body)).toContain('"totalCheckIns":2');
      const list = await request(app).get(`/api/v1/events/${event._id}/checkins`).set(auth(tOrg));
      expect(list.body.data).toHaveLength(2);
      expect(await Session.countDocuments({ eventId: event._id })).toBe(1);
    });

    it('new invitations and resends are refused, and no new pass is minted', async () => {
      await cancel();
      await settle(event._id);
      const hashBefore = (await Invitee.findById(guests.unsent.inv._id))?.qrTokenHash;
      emailSpy.mockClear();
      const send = await request(app).post(`/api/v1/events/${event._id}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: [String(guests.unsent.inv._id)], channel: 'EMAIL' });
      expect(send.status).toBe(409);
      expect(send.body.code).toBe('EVENT_CANCELLED');
      const inv: any = await Invitation.findOne({ inviteeId: guests.accepted.inv._id });
      const resend = await request(app).post(`/api/v1/events/${event._id}/invitations/resend`).set(auth(tAdmin)).send({ invitationIds: [String(inv._id)] });
      expect(resend.status).toBe(409);
      expect(resend.body.code).toBe('EVENT_CANCELLED');
      expect(emailSpy).not.toHaveBeenCalled();
      expect((await Invitee.findById(guests.unsent.inv._id))?.qrTokenHash).toBe(hashBefore);
      expect(await Invitation.countDocuments({ eventId: event._id })).toBe(7);
    });

    it('RSVP accept, decline and dietary changes are refused and nothing is saved', async () => {
      await cancel();
      await settle(event._id);
      for (const body of [{ rsvpStatus: 'ACCEPTED' }, { rsvpStatus: 'DECLINED' }, { rsvpStatus: 'ACCEPTED', dietaryPreference: 'Veg' }, { rsvpStatus: 'ACCEPTED', dietarySelections: [{ title: 'x', value: 'y' }] }]) {
        const res = await request(app).post(`/api/v1/public/invitations/${guests.pending.raw}/rsvp`).send(body);
        expect(res.status).toBe(410);
        expect(res.body.code).toBe('EVENT_CANCELLED');
      }
      const inv: any = await Invitee.findById(guests.pending.inv._id);
      expect(inv.rsvpStatus).toBe(RsvpStatus.PENDING);
      expect(inv.dietaryPreference).toBeUndefined();
    });

    it('an existing invitation link opens a clear cancellation notice instead of an error, and exposes nothing internal', async () => {
      await cancel(tOrg, { reason: 'Venue unavailable' });
      await settle(event._id);
      const res = await request(app).get(`/api/v1/public/invitations/${guests.accepted.raw}`);
      expect(res.status).toBe(200);
      expect(res.body.data.event.status).toBe('CANCELLED');
      expect(res.body.data.event.cancellation).toMatchObject({ reason: 'Venue unavailable' });
      expect(res.body.data.event.cancellation.cancelledAt).toBeTruthy();
      const text = JSON.stringify(res.body);
      for (const secret of [guests.accepted.raw, hashToken(guests.accepted.raw), 'organizerId', 'cancelledBy', 'qrToken']) expect(text).not.toContain(secret);
      const card = await request(app).get(`/api/v1/public/invitations/${guests.accepted.raw}/card`);
      expect(card.status).toBe(410);
      expect(card.body.code).toBe('EVENT_CANCELLED');
      expect(card.headers['content-type']).not.toContain('image/png');
    });

    it('on a standalone database (no transactions) a scan racing a cancel still leaves no attendance after it', async () => {
      const start = jest.spyOn(mongoose, 'startSession');
      const all = Object.values(guests).filter((g) => g.inv.invitationStatus === 'SENT').map((g) => g.raw);
      const results = await Promise.all(all.map((raw, i) => (i === 2 ? (request(app).post(`/api/v1/events/${event._id}/cancel`).set(auth(tOrg)).send({}) as any) : scan(raw))));
      await settle(event._id);
      expect(start).not.toHaveBeenCalled(); // this server cannot do transactions: the compensating path ran
      const scans = results.filter((_, i) => i !== 2);
      const stored = await CheckIn.countDocuments();
      expect(scans.filter((r) => r.status === 201)).toHaveLength(stored); // what staff were told is what is stored
      for (const r of scans.filter((x) => x.status !== 201)) expect(r.body.code).toBe('EVENT_CANCELLED');
      const late = await scan(guests.accepted.raw);
      expect([409]).toContain(late.status);
      expect(await CheckIn.countDocuments()).toBe(stored);
    });

    it('a live event\'s page carries no cancellation block', async () => {
      const res = await request(app).get(`/api/v1/public/invitations/${guests.accepted.raw}`);
      expect(res.body.data.event.cancellation).toBeNull();
    });
  });

  // ───────────── audit & history ─────────────
  describe('audit and history', () => {
    it('records who cancelled, why and for which tenant; the organizer can read it; no secrets', async () => {
      await cancel(tOrg, { reason: 'Venue unavailable' });
      await settle(event._id);
      // the audit entry is completed after the response is sent: wait for it to leave PENDING
      for (let i = 0; i < 80 && (await AuditLog.countDocuments({ action: 'EVENT_CANCEL', status: { $ne: 'PENDING' } })) === 0; i++) await new Promise((r) => setTimeout(r, 25));
      const row: any = await AuditLog.findOne({ action: 'EVENT_CANCEL' });
      expect(row.status).toBe('SUCCESS');
      expect(String(row.actorId)).toBe(String(org._id));
      expect(row.actorType).toBe('ORGANIZER');
      expect(String(row.eventId)).toBe(String(event._id));
      expect(String(row.organizerId)).toBe(String(org._id));
      expect(row.metadata.reason).toBe('Venue unavailable');
      expect(JSON.stringify(row.toObject())).not.toMatch(/@x\.com|98765432\d\d/);
      const log = await request(app).get(`/api/v1/audit-logs?eventId=${event._id}`).set(auth(tOrg));
      expect(log.body.data.map((r: any) => r.action)).toEqual(expect.arrayContaining(['EVENT_CANCEL', 'EVENT_CANCEL_NOTIFICATIONS']));
      expect((await request(app).get(`/api/v1/audit-logs?eventId=${event._id}`).set(auth(tOther))).body.data).toHaveLength(0);
    });

    it('refuses to cancel (and changes nothing) when the audit record cannot be written', async () => {
      jest.spyOn(auditLogRepository, 'create').mockRejectedValue(new Error('db down'));
      const res = await cancel();
      expect(res.status).toBe(503);
      expect((await Event.findById(event._id))?.status).toBe(EventStatus.PUBLISHED);
      expect(await CancellationNotice.countDocuments()).toBe(0);
      expect(emailSpy).not.toHaveBeenCalled();
    });

    it('keeps RSVP answers, invitations, guests and earlier audit entries', async () => {
      await request(app).patch(`/api/v1/events/${event._id}`).set(auth(tOrg)).send({ title: 'Summit 2' });
      await new Promise((r) => setTimeout(r, 100));
      const auditBefore = await AuditLog.countDocuments({ action: 'EVENT_UPDATE' });
      const rsvp = (await Invitee.find({ eventId: event._id }).lean()).map((i: any) => [i.name, i.rsvpStatus]).sort();
      await cancel();
      await settle(event._id);
      expect((await Invitee.find({ eventId: event._id }).lean()).map((i: any) => [i.name, i.rsvpStatus]).sort()).toEqual(rsvp);
      expect(await Invitee.countDocuments({ eventId: event._id })).toBe(8);
      expect(await Invitation.countDocuments({ eventId: event._id })).toBe(7);
      expect(await AuditLog.countDocuments({ action: 'EVENT_UPDATE' })).toBe(auditBefore);
      expect((await request(app).get(`/api/v1/events/${event._id}`).set(auth(tOrg))).status).toBe(200);
    });
  });
});
