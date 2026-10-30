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
import { clock } from '../src/utils/clock';
import { admissionState, effectiveAdmission, validateAdmissionInput } from '../src/utils/admissionWindow';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

// The product example, in the platform timezone (Asia/Kolkata, UTC+05:30):
// event 10:00-17:00 IST on 31 Oct 2026, check-in opens at 09:00 IST, closes (by default) at the event's end.
const START = new Date('2026-10-31T04:30:00.000Z'); // 10:00 IST
const END = new Date('2026-10-31T11:30:00.000Z'); // 17:00 IST
const OPENS = new Date('2026-10-31T03:30:00.000Z'); // 09:00 IST
const at = (d: Date, ms = 0) => new Date(d.getTime() + ms);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('P0.2 — admission windows and secure QR admission', () => {
  let mongoServer: MongoMemoryServer;
  let org: any, other: any, staff: any, staff2: any, admin: any;
  let tOrg: string, tOther: string, tStaff: string, tStaff2: string, tAdmin: string;
  let event: any, otherEvent: any, s1: any, s2: any;
  let guest: any, guestToken: string, guest2: any, guestToken2: string;

  const scan = (token: string, body: Record<string, unknown> = {}, who = tOrg) =>
    request(app).post('/api/v1/checkins/scan').set(auth(who)).send({ qrCode: token, eventId: String(event._id), ...body });
  const setNow = (d: Date) => jest.spyOn(clock, 'now').mockReturnValue(d);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([User, Event, Session, Invitee, Invitation, SystemUserAssignment, CheckIn, AuditLog].map((m: any) => m.deleteMany({})));
    const mk = (fullName: string, email: string, role: Role) => User.create({ fullName, email, role, isActive: true });
    org = await mk('Org', 'org@x.com', Role.ORGANIZER);
    other = await mk('Other Org', 'other@x.com', Role.ORGANIZER);
    staff = await mk('Staff', 'staff@x.com', Role.SYSTEM_USER);
    staff2 = await mk('Staff Two', 'staff2@x.com', Role.SYSTEM_USER);
    admin = await mk('Admin', 'admin@x.com', Role.ADMIN);
    tOrg = generateAccessToken(String(org._id), org.role);
    tOther = generateAccessToken(String(other._id), other.role);
    tStaff = generateAccessToken(String(staff._id), staff.role);
    tStaff2 = generateAccessToken(String(staff2._id), staff2.role);
    tAdmin = generateAccessToken(String(admin._id), admin.role);

    const mkEvent = (organizerId: any, extra: Record<string, unknown> = {}) => Event.create({
      organizerId, title: 'Summit', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL,
      schedule: { start: START, end: END }, status: EventStatus.PUBLISHED,
      rsvp: { enabled: false, allowAllInvited: true, allowNotResponded: true, allowDeclined: true }, ...extra
    });
    event = await mkEvent(org._id, { admission: { opensAt: OPENS } });
    otherEvent = await mkEvent(other._id);
    const mkSession = (name: string, extra: Record<string, unknown> = {}) => Session.create({
      eventId: event._id, name, schedule: { start: START, end: END }, accessControl: AccessControl.ONLY_ONCE,
      validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST, ...extra
    });
    s1 = await mkSession('Keynote');
    s2 = await mkSession('Workshop');

    const mkGuest = async (name: string, email: string) => {
      const raw = generateSecureToken();
      const inv = await Invitee.create({ eventId: event._id, name, email, invitationStatus: InvitationStatus.SENT, rsvpStatus: RsvpStatus.ACCEPTED, qrTokenHash: hashToken(raw), sessionAccess: [] });
      return { inv, raw };
    };
    ({ inv: guest, raw: guestToken } = await mkGuest('Guest One', 'g1@x.com'));
    ({ inv: guest2, raw: guestToken2 } = await mkGuest('Guest Two', 'g2@x.com'));
    await SystemUserAssignment.create({ userId: staff._id, eventId: event._id, sessionIds: [], assignedBy: org._id });
  });
  afterEach(() => jest.restoreAllMocks());

  // ───────────── repeat entry (session access control) ─────────────
  describe('session access control: Only Once vs No Restrictions', () => {
    it('Only Once: the second scan of the same session is rejected', async () => {
      setNow(at(START, 60e3));
      expect((await scan(guestToken, { sessionId: String(s1._id) })).status).toBe(201);
      const again = await scan(guestToken, { sessionId: String(s1._id) });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(await CheckIn.countDocuments({ inviteeId: guest._id, sessionId: s1._id })).toBe(1);
    });

    it('No Restrictions: repeat scans of the same session are allowed and counted on one record', async () => {
      await Session.updateOne({ _id: s1._id }, { accessControl: AccessControl.NO_RESTRICTION });
      setNow(at(START, 60e3));
      for (let i = 0; i < 3; i++) expect((await scan(guestToken, { sessionId: String(s1._id) })).status).toBeLessThan(300);
      const rows: any[] = await CheckIn.find({ inviteeId: guest._id, sessionId: s1._id }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0].scanCount).toBe(3);
    });

    it('No Restrictions on one session does not loosen Only Once on another', async () => {
      await Session.updateOne({ _id: s1._id }, { accessControl: AccessControl.NO_RESTRICTION });
      setNow(at(START, 60e3));
      expect((await scan(guestToken, { sessionId: String(s2._id) })).status).toBe(201);
      expect((await scan(guestToken, { sessionId: String(s2._id) })).status).toBeGreaterThanOrEqual(400);
    });

    it('No Restrictions: concurrent scans never create a second record', async () => {
      await Session.updateOne({ _id: s1._id }, { accessControl: AccessControl.NO_RESTRICTION });
      setNow(at(START, 60e3));
      const res = await Promise.all(Array.from({ length: 5 }, () => scan(guestToken, { sessionId: String(s1._id) })));
      expect(res.every((r) => r.status < 300)).toBe(true);
      expect(await CheckIn.countDocuments({ inviteeId: guest._id, sessionId: s1._id })).toBe(1);
    });
  });

  describe('removing a session from a staff member\'s assignment', () => {
    it('blocks scanning that session at once and leaves the other sessions working', async () => {
      const assignment: any = await SystemUserAssignment.findOne({ userId: staff._id, eventId: event._id });
      const assign = (sessionIds: string[]) => request(app).patch(`/api/v1/assignments/${assignment._id}`).set(auth(tOrg)).send({ sessionIds });
      expect((await assign([String(s1._id), String(s2._id)])).status).toBeLessThan(300);
      setNow(at(START, 60e3));
      expect((await scan(guestToken, { sessionId: String(s2._id) }, tStaff)).status).toBe(201);
      expect((await assign([String(s1._id)])).status).toBeLessThan(300);
      const blocked = await scan(guestToken2, { sessionId: String(s2._id) }, tStaff);
      expect(blocked.status).toBe(403);
      expect(await CheckIn.countDocuments({ inviteeId: guest2._id })).toBe(0);
      expect((await scan(guestToken2, { sessionId: String(s1._id) }, tStaff)).status).toBe(201);
    });
  });

  // ───────────── the window ─────────────
  describe('admission window (server clock, half-open)', () => {
    it('before opening: refused with a distinguishable code and the opening time in the platform timezone', async () => {
      setNow(at(OPENS, -1));
      const res = await scan(guestToken);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ADMISSION_NOT_OPEN');
      expect(res.body.message).toMatch(/not opened yet/);
      expect(res.body.message).toMatch(/9:00\s?am IST/i); // 03:30Z is 09:00 in Asia/Kolkata
      expect(res.body.opensAt).toBe(OPENS.toISOString());
      expect(await CheckIn.countDocuments()).toBe(0);
    });

    it('exactly at opening: admitted, an hour before the event itself starts', async () => {
      setNow(OPENS);
      expect((await scan(guestToken)).status).toBe(201);
    });

    it('during the window, including after the scheduled start', async () => {
      setNow(at(START, 60 * 60e3));
      expect((await scan(guestToken)).status).toBe(201);
    });

    it('one millisecond before closing: admitted', async () => {
      setNow(at(END, -1));
      expect((await scan(guestToken)).status).toBe(201);
    });

    it('exactly at closing: refused (the window is half-open)', async () => {
      setNow(END);
      const res = await scan(guestToken);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('CREDENTIAL_EXPIRED');
      expect(res.body.message).toMatch(/expired/i);
      expect(await CheckIn.countDocuments()).toBe(0);
    });

    it('after closing: refused, and stays refused on every later scan with no background job', async () => {
      setNow(at(END, 5 * 60e3));
      for (let i = 0; i < 3; i++) expect((await scan(guestToken)).body.code).toBe('CREDENTIAL_EXPIRED');
      setNow(at(END, 48 * 3600e3));
      expect((await scan(guestToken)).body.code).toBe('CREDENTIAL_EXPIRED');
    });

    it('manual entry after closing says admission has ended', async () => {
      setNow(at(END, 1));
      const res = await request(app).post('/api/v1/checkins/manual').set(auth(tOrg)).send({ eventId: String(event._id), inviteeId: String(guest._id) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ADMISSION_CLOSED');
      expect(res.body.message).toMatch(/admission has ended/i);
    });

    it('the device clock is never consulted: client-sent times are ignored', async () => {
      setNow(at(END, 1));
      const res = await scan(guestToken, { now: OPENS.toISOString(), scannedAt: OPENS.toISOString() });
      expect(res.status).toBe(410);
    });

    it('an explicit closing time beats the event end (and can extend it)', async () => {
      await Event.updateOne({ _id: event._id }, { 'admission.closesAt': at(END, 3600e3) });
      setNow(at(END, 1800e3));
      expect((await scan(guestToken)).status).toBe(201);
      setNow(at(END, 3600e3));
      expect((await scan(guestToken2)).body.code).toBe('CREDENTIAL_EXPIRED');
    });

    it('an event with no admission fields follows its schedule (opens at start, closes at end)', async () => {
      await Event.updateOne({ _id: event._id }, { $unset: { admission: 1 } });
      const raw: any = await Event.collection.findOne({ _id: event._id });
      expect(raw.admission).toBeUndefined();
      setNow(at(START, -1));
      expect((await scan(guestToken)).body.code).toBe('ADMISSION_NOT_OPEN');
      setNow(START);
      expect((await scan(guestToken)).status).toBe(201);
      setNow(END);
      expect((await scan(guestToken2)).body.code).toBe('CREDENTIAL_EXPIRED');
    });

    it('window arithmetic: defaults, state and validation', () => {
      const w = effectiveAdmission({ schedule: { start: START, end: END }, admission: {} })!;
      expect(w.opensAt).toEqual(START);
      expect(w.closesAt).toEqual(END);
      expect(w.opensAtIsDefault && w.closesAtIsDefault).toBe(true);
      expect(admissionState(w, at(END, -1))).toBe('OPEN');
      expect(admissionState(w, END)).toBe('CLOSED');
      expect(validateAdmissionInput({ start: START, end: END }, { opensAt: END, closesAt: START })).toMatch(/open before it closes/);
      expect(validateAdmissionInput({ start: START, end: END }, { opensAt: OPENS })).toBeNull();
      expect(validateAdmissionInput({ start: START, end: END }, { opensAt: 'nonsense' as any })).toMatch(/valid dates/);
    });
  });

  // ───────────── event status ─────────────
  describe('event status beats the window', () => {
    it.each([
      [EventStatus.CANCELLED, 'EVENT_CANCELLED', /cancelled/i],
      [EventStatus.COMPLETED, 'EVENT_COMPLETED', /completed/i],
      [EventStatus.DRAFT, 'EVENT_NOT_PUBLISHED', /not open/i]
    ])('%s event refuses entry inside the window', async (status, code, message) => {
      await Event.updateOne({ _id: event._id }, { status });
      setNow(at(START, 3600e3));
      const res = await scan(guestToken);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(code);
      expect(res.body.message).toMatch(message);
      expect(await CheckIn.countDocuments()).toBe(0);
    });

    it('a closed event (Phase 1 close) refuses entry', async () => {
      setNow(at(START, 3600e3));
      expect((await request(app).post(`/api/v1/events/${event._id}/close`).set(auth(tOrg))).status).toBe(200);
      expect((await scan(guestToken)).body.code).toBe('EVENT_COMPLETED');
    });
  });

  // ───────────── credential ─────────────
  describe('credential', () => {
    beforeEach(() => setNow(at(START, 60e3)));

    it('revoked: refused for scan and manual entry', async () => {
      await Invitee.updateOne({ _id: guest._id }, { credentialRevokedAt: new Date() });
      const res = await scan(guestToken);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('CREDENTIAL_REVOKED');
      expect(res.body.message).toMatch(/revoked/i);
      const manual = await request(app).post('/api/v1/checkins/manual').set(auth(tOrg)).send({ eventId: String(event._id), inviteeId: String(guest._id) });
      expect(manual.body.code).toBe('CREDENTIAL_REVOKED');
      expect(await CheckIn.countDocuments()).toBe(0);
    });

    it('invalid and replaced passes are told apart and reveal nothing', async () => {
      const bad = await scan(generateSecureToken());
      expect(bad.status).toBe(404);
      expect(bad.body.code).toBe('INVALID_QR_TOKEN');
      expect(JSON.stringify(bad.body)).not.toMatch(/Guest/);
      const old = generateSecureToken();
      await Invitation.create({ eventId: event._id, inviteeId: guest._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.SENT, tokenHash: hashToken(old) });
      expect((await scan(old)).body.code).toBe('QR_TOKEN_SUPERSEDED');
    });

    it('the pass itself never appears in any refusal', async () => {
      setNow(at(END, 1));
      const res = await scan(guestToken);
      expect(JSON.stringify(res.body)).not.toContain(guestToken);
      expect(JSON.stringify(res.body)).not.toContain(hashToken(guestToken));
    });
  });

  // ───────────── staff ─────────────
  describe('staff authorization comes first', () => {
    beforeEach(() => setNow(at(START, 60e3)));

    it('an assigned staff member can admit', async () => {
      expect((await scan(guestToken, {}, tStaff)).status).toBe(201);
    });

    it('a staff member with no assignment is refused, even outside the window, before anything about the pass is revealed', async () => {
      setNow(at(END, 1));
      const res = await scan(guestToken, {}, tStaff2);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STAFF_EVENT_FORBIDDEN');
    });

    it('a staff member assigned to a different event cannot admit here', async () => {
      await SystemUserAssignment.create({ userId: staff2._id, eventId: otherEvent._id, sessionIds: [], assignedBy: other._id });
      expect((await scan(guestToken, {}, tStaff2)).status).toBe(403);
      // nor by omitting the event: the pass leads to this event, and the assignment is checked against it
      const res = await request(app).post('/api/v1/checkins/scan').set(auth(tStaff2)).send({ qrCode: guestToken });
      expect(res.status).toBe(403);
    });

    it('another organizer cannot admit guests of this event', async () => {
      expect((await scan(guestToken, {}, tOther)).status).toBe(403);
    });

    it('admin may admit', async () => {
      expect((await scan(guestToken, {}, tAdmin)).status).toBe(201);
    });
  });

  // ───────────── sessions ─────────────
  describe('sessions', () => {
    beforeEach(async () => {
      setNow(at(START, 60e3));
      await SystemUserAssignment.updateOne({ userId: staff._id, eventId: event._id }, { sessionIds: [s1._id] });
    });

    it('staff limited to sessions cannot bypass the limit by leaving the session out', async () => {
      const res = await scan(guestToken, {}, tStaff);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SESSION_REQUIRED');
      expect(await CheckIn.countDocuments()).toBe(0);
      const manual = await request(app).post('/api/v1/checkins/manual').set(auth(tStaff)).send({ eventId: String(event._id), inviteeId: String(guest._id) });
      expect(manual.body.code).toBe('SESSION_REQUIRED');
    });

    it('wrong session is refused; the assigned session is admitted', async () => {
      const wrong = await scan(guestToken, { sessionId: String(s2._id) }, tStaff);
      expect(wrong.status).toBe(403);
      expect(wrong.body.code).toBe('STAFF_SESSION_FORBIDDEN');
      const ok = await scan(guestToken, { sessionId: String(s1._id) }, tStaff);
      expect(ok.status).toBe(201);
      expect(ok.body.data.session.name).toBe('Keynote');
    });

    it('a session that does not belong to the event is refused', async () => {
      const foreign = await Session.create({ eventId: otherEvent._id, name: 'Foreign', schedule: { start: START, end: END }, accessControl: AccessControl.NO_RESTRICTION, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
      const res = await scan(guestToken, { sessionId: String(foreign._id) }, tOrg);
      expect(res.status).toBe(404);
    });

    it('an organizer without session restrictions may still admit event-wide', async () => {
      expect((await scan(guestToken, {}, tOrg)).status).toBe(201);
    });

    it('a session with its own window: refused before it opens, admitted during, refused after - without touching event-wide entry', async () => {
      const sessionOpens = at(START, 2 * 3600e3);
      const sessionCloses = at(START, 4 * 3600e3);
      await Session.updateOne({ _id: s2._id }, { admission: { opensAt: sessionOpens, closesAt: sessionCloses } });

      setNow(at(sessionOpens, -1));
      const early = await scan(guestToken, { sessionId: String(s2._id) });
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('SESSION_NOT_OPEN');
      // the same guest can still be admitted event-wide and into a session with no window of its own
      expect((await scan(guestToken)).status).toBe(201);
      expect((await scan(guestToken, { sessionId: String(s1._id) })).status).toBe(201);

      setNow(sessionOpens);
      expect((await scan(guestToken, { sessionId: String(s2._id) })).status).toBe(201);

      setNow(sessionCloses);
      const late = await scan(guestToken2, { sessionId: String(s2._id) });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('SESSION_CLOSED');
      expect((await scan(guestToken2, { sessionId: String(s1._id) })).status).toBe(201);
    });

    it('the event window still gates a session scan', async () => {
      await Session.updateOne({ _id: s2._id }, { admission: { opensAt: START, closesAt: at(END, 3600e3) } });
      setNow(END);
      expect((await scan(guestToken, { sessionId: String(s2._id) })).body.code).toBe('CREDENTIAL_EXPIRED');
    });
  });

  // ───────────── repeats and races ─────────────
  describe('repeat entry and concurrency', () => {
    beforeEach(() => setNow(at(START, 60e3)));

    it('a repeat scan is refused as already checked in', async () => {
      expect((await scan(guestToken)).status).toBe(201);
      const again = await scan(guestToken);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_CHECKED_IN');
      expect(await CheckIn.countDocuments({ inviteeId: guest._id })).toBe(1);
    });

    it('simultaneous scans of one pass produce exactly one attendance record (event-wide)', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => scan(guestToken)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409 && r.body.code === 'ALREADY_CHECKED_IN')).toHaveLength(7);
      expect(await CheckIn.countDocuments({ inviteeId: guest._id })).toBe(1);
    });

    it('simultaneous scans into a session, mixing scan and manual entry, still produce one record', async () => {
      const sid = String(s1._id);
      const calls = [
        ...Array.from({ length: 4 }, () => scan(guestToken, { sessionId: sid })),
        ...Array.from({ length: 4 }, () => request(app).post('/api/v1/checkins/manual').set(auth(tOrg)).send({ eventId: String(event._id), inviteeId: String(guest._id), sessionId: sid }))
      ];
      const results = await Promise.all(calls);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(await CheckIn.countDocuments({ inviteeId: guest._id, sessionId: s1._id })).toBe(1);
    });
  });

  // ───────────── history ─────────────
  describe('history is kept when the window ends', () => {
    it('nothing is deleted or hidden after closing', async () => {
      setNow(at(START, 60e3));
      expect((await scan(guestToken)).status).toBe(201);
      await Invitation.create({ eventId: event._id, inviteeId: guest._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.SENT, tokenHash: hashToken(guestToken) });
      const counts = async () => ({
        invitees: await Invitee.countDocuments({ eventId: event._id }),
        invitations: await Invitation.countDocuments({ eventId: event._id }),
        checkIns: await CheckIn.countDocuments({ eventId: event._id }),
        sessions: await Session.countDocuments({ eventId: event._id }),
        audit: await AuditLog.countDocuments()
      });
      const before = await counts();

      setNow(at(END, 24 * 3600e3));
      expect((await scan(guestToken2)).status).toBe(410);
      expect((await scan(guestToken)).status).toBe(410);
      const after = await counts();
      expect(after.invitees).toBe(before.invitees);
      expect(after.invitations).toBe(before.invitations);
      expect(after.checkIns).toBe(before.checkIns);
      expect(after.sessions).toBe(before.sessions);

      const list = await request(app).get(`/api/v1/events/${event._id}/checkins`).set(auth(tOrg));
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect((await request(app).get(`/api/v1/reports/events/${event._id}`).set(auth(tOrg))).status).toBe(200);
      expect((await Invitee.findById(guest._id))?.rsvpStatus).toBe(RsvpStatus.ACCEPTED);
    });
  });

  // ───────────── configuring the window ─────────────
  describe('configuring the window (API)', () => {
    const patch = (body: unknown, who = tOrg, id = event._id) => request(app).patch(`/api/v1/events/${id}/admission`).set(auth(who)).send(body as object);

    it('an organizer can open earlier or later, and the change is audited', async () => {
      const res = await patch({ opensAt: '2026-10-31T02:30:00.000Z' });
      expect(res.status).toBe(200);
      expect(new Date((await Event.findById(event._id) as any).admission.opensAt).toISOString()).toBe('2026-10-31T02:30:00.000Z');
      const row: any = await AuditLog.findOne({ action: 'EVENT_ADMISSION_UPDATE' });
      expect(row.status).toBe('SUCCESS');
      expect(String(row.actorId)).toBe(String(org._id));
    });

    it('is allowed after invitations were sent (the general edit stays locked)', async () => {
      await Invitation.create({ eventId: event._id, inviteeId: guest._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.SENT, tokenHash: hashToken('x') });
      expect((await patch({ closesAt: '2026-10-31T12:30:00.000Z' })).status).toBe(200);
      const edit = await request(app).patch(`/api/v1/events/${event._id}`).set(auth(tOrg)).send({ title: 'Renamed' });
      expect(edit.status).toBe(409);
      expect(edit.body.code).toBe('EVENT_LOCKED');
    });

    it('null returns a side to its default; a one-sided change keeps the other side', async () => {
      await patch({ closesAt: '2026-10-31T12:30:00.000Z' });
      await patch({ opensAt: null });
      const ev: any = await Event.findById(event._id);
      expect(ev.admission.opensAt).toBeFalsy();
      expect(new Date(ev.admission.closesAt).toISOString()).toBe('2026-10-31T12:30:00.000Z');
      setNow(at(START, -1));
      expect((await scan(guestToken)).body.code).toBe('ADMISSION_NOT_OPEN'); // defaults to the 10:00 start again
    });

    it('rejects opening at or after closing, and malformed times', async () => {
      expect((await patch({ opensAt: '2026-10-31T12:00:00.000Z' })).status).toBe(400); // after the 11:30Z end
      expect((await patch({ opensAt: '2026-10-31T11:30:00.000Z' })).status).toBe(400); // equal to the end
      expect((await patch({ opensAt: 'tomorrow' })).status).toBe(400);
      expect((await patch({ bogus: 1 })).status).toBe(400);
    });

    it('is authorised: owner or admin only; staff and other organizers are refused', async () => {
      expect((await patch({ opensAt: null }, tStaff)).status).toBe(403);
      expect((await patch({ opensAt: null }, tOther)).status).toBe(404);
      expect((await patch({ opensAt: null }, tAdmin)).status).toBe(200);
    });

    it('is refused for closed and cancelled events', async () => {
      await Event.updateOne({ _id: event._id }, { status: EventStatus.COMPLETED });
      expect((await patch({ opensAt: null })).status).toBe(409);
    });

    it('is checked when an event is edited together with its schedule', async () => {
      await Invitation.deleteMany({});
      const bad = await request(app).patch(`/api/v1/events/${event._id}`).set(auth(tOrg))
        .send({ schedule: { start: '2026-10-31T05:30:00.000Z', end: '2026-10-31T06:30:00.000Z' } }); // stored opensAt 03:30Z stays valid
      expect(bad.status).toBe(200);
      const worse = await request(app).patch(`/api/v1/events/${event._id}`).set(auth(tOrg))
        .send({ schedule: { start: '2026-10-30T01:00:00.000Z', end: '2026-10-30T02:00:00.000Z' } }); // ends before the stored opening
      expect(worse.status).toBe(400);
    });

    it('can be set when the event is created, and is validated there', async () => {
      const ok = await request(app).post('/api/v1/events').set(auth(tOrg)).send({
        title: 'Created with a window', location: { address: 'Hall' }, schedule: { start: '2027-01-10T04:30:00.000Z', end: '2027-01-10T11:30:00.000Z' },
        admission: { opensAt: '2027-01-10T03:30:00.000Z' }
      });
      expect(ok.status).toBe(201);
      const stored: any = await Event.findOne({ title: 'Created with a window' });
      expect(new Date(stored.admission.opensAt).toISOString()).toBe('2027-01-10T03:30:00.000Z');
      const bad = await request(app).post('/api/v1/events').set(auth(tOrg)).send({
        title: 'Backwards', location: { address: 'Hall' }, schedule: { start: '2027-01-10T04:30:00.000Z', end: '2027-01-10T11:30:00.000Z' },
        admission: { opensAt: '2027-01-10T12:00:00.000Z' }
      });
      expect(bad.status).toBe(400);
    });
  });

  // ───────────── invitation experience ─────────────
  describe('what the guest sees', () => {
    it('the public invitation reports the effective window, defaults included', async () => {
      const res = await request(app).get(`/api/v1/public/invitations/${guestToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.event.admission).toEqual({ opensAt: OPENS.toISOString(), closesAt: END.toISOString() });
      expect(res.body.data.event.timeZone).toBeTruthy();
      await Event.updateOne({ _id: event._id }, { $unset: { admission: 1 } });
      const legacy = await request(app).get(`/api/v1/public/invitations/${guestToken}`);
      expect(legacy.body.data.event.admission).toEqual({ opensAt: START.toISOString(), closesAt: END.toISOString() });
    });
  });
});
