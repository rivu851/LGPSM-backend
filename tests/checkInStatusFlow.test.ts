import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { CheckIn } from '../src/models/CheckIn';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

jest.setTimeout(60000);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

// Who is scanned, who is checked in, who is still pending and who counts as an attendee: every screen and count must agree
// after a door shift (QR scans, a manual entry, a repeat scan, a guest who is not invited to a session).
describe('check-in statuses stay consistent for the door staff, the organizer and the reports', () => {
  let mongo: MongoMemoryServer;
  let org: any, staff: any, tOrg: string, tStaff: string, event: any, s1: any, s2: any;
  let A: any, B: any, C: any, D: any;
  const raw: Record<string, string> = {};

  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => {
    await Promise.all([User, Event, Session, Invitee, SystemUserAssignment, CheckIn].map((m: any) => m.deleteMany({})));
    org = await User.create({ fullName: 'Org', email: 'org@x.com', role: Role.ORGANIZER, isActive: true });
    staff = await User.create({ fullName: 'Door Staff', email: 'staff@x.com', role: Role.SYSTEM_USER, isActive: true, createdBy: org._id });
    tOrg = generateAccessToken(String(org._id), org.role);
    tStaff = generateAccessToken(String(staff._id), staff.role);
    event = await Event.create({ organizerId: org._id, title: 'Gala', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, status: EventStatus.PUBLISHED, schedule: { start: new Date(Date.now() - 36e5), end: new Date(Date.now() + 5 * 36e5) }, rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: false } });
    const mkSession = (name: string, access: AccessControl) => Session.create({ eventId: event._id, name, schedule: { start: new Date(Date.now() - 36e5), end: new Date(Date.now() + 5 * 36e5) }, accessControl: access, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    s1 = await mkSession('Lunch', AccessControl.ONLY_ONCE);
    s2 = await mkSession('Dinner', AccessControl.NO_RESTRICTION);
    await SystemUserAssignment.create({ userId: staff._id, eventId: event._id, sessionIds: [], assignedBy: org._id }); // staff on every session
    const mk = async (key: string, name: string, access: any[], phone: string) => {
      raw[key] = generateSecureToken();
      return Invitee.create({ eventId: event._id, name, email: `${key}@x.com`, mobile: phone, invitationStatus: InvitationStatus.SENT, rsvpStatus: RsvpStatus.ACCEPTED, qrTokenHash: hashToken(raw[key]), sessionAccess: access });
    };
    A = await mk('a', 'Amit', [], '9000000001'); // every session
    B = await mk('b', 'Bela', [{ sessionId: s1._id, allowed: true }], '9000000002'); // Lunch only
    C = await mk('c', 'Chanchal', [{ sessionId: s2._id, allowed: true }], '9000000003'); // Dinner only
    D = await mk('d', 'Dev', [], '9000000004'); // every session
  });

  const scan = (key: string, sessionId: any) => request(app).post('/api/v1/checkins/scan').set(auth(tStaff)).send({ qrCode: raw[key], eventId: String(event._id), sessionId: String(sessionId) });
  const manual = (inviteeId: any, sessionId: any) => request(app).post('/api/v1/checkins/manual').set(auth(tStaff)).send({ eventId: String(event._id), inviteeId: String(inviteeId), sessionId: String(sessionId) });
  const list = async (query: string) => (await request(app).get(`/api/v1/events/${event._id}/invitees?limit=50&${query}`).set(auth(tStaff))).body;
  const names = (b: any) => b.data.map((i: any) => i.name).sort();

  it('after a door shift, every count and list agrees', async () => {
    expect((await scan('a', s1._id)).status).toBe(201); // Amit: Lunch
    expect((await scan('a', s1._id)).status).toBe(409); // a second scan of the same Lunch pass is refused
    expect((await scan('c', s1._id)).status).toBeGreaterThanOrEqual(400); // Chanchal is not invited to Lunch
    expect((await manual(B._id, s1._id)).status).toBe(201); // Bela: Lunch, by hand
    expect((await scan('a', s2._id)).status).toBe(201); // Amit again, at Dinner (still one attendee)

    // Lunch: the guests who can attend it are Amit, Bela and Dev (not Chanchal); two are in, one is pending
    const lunchAll = await list(`sessionId=${s1._id}`);
    expect(lunchAll.meta.total).toBe(3);
    expect(names(lunchAll)).toEqual(['Amit', 'Bela', 'Dev']);
    const lunchIn = await list(`sessionId=${s1._id}&checkInStatus=CHECKED_IN`);
    expect(names(lunchIn)).toEqual(['Amit', 'Bela']);
    expect(lunchIn.data.every((i: any) => i.isCheckedIn)).toBe(true);
    const lunchPending = await list(`sessionId=${s1._id}&checkInStatus=PENDING`);
    expect(names(lunchPending)).toEqual(['Dev']);
    expect(lunchPending.meta.total).toBe(lunchAll.meta.total - lunchIn.meta.total); // pending = invited - in

    // Dinner: Amit, Chanchal and Dev can attend it; only Amit is in
    const dinnerAll = await list(`sessionId=${s2._id}`);
    expect(names(dinnerAll)).toEqual(['Amit', 'Chanchal', 'Dev']);
    expect(names(await list(`sessionId=${s2._id}&checkInStatus=CHECKED_IN`))).toEqual(['Amit']);
    expect(names(await list(`sessionId=${s2._id}&checkInStatus=PENDING`))).toEqual(['Chanchal', 'Dev']);

    // the whole event: Amit and Bela have been in somewhere; Chanchal and Dev have not
    expect(names(await list('checkInStatus=CHECKED_IN'))).toEqual(['Amit', 'Bela']);
    expect(names(await list('checkInStatus=PENDING'))).toEqual(['Chanchal', 'Dev']);

    // the report: distinct attendees, and per session the invited, attendee and entry counts
    const rep = (await request(app).get(`/api/v1/reports/events/${event._id}`).set(auth(tOrg))).body.data;
    expect(rep.totalInvitees).toBe(4);
    expect(rep.uniqueAttendees).toBe(2);
    const bySession = Object.fromEntries(rep.sessionReports.map((r: any) => [r.name, r]));
    expect(bySession['Lunch']).toMatchObject({ invitedCount: 3, attendeeCount: 2, checkInCount: 2 });
    expect(bySession['Dinner']).toMatchObject({ invitedCount: 3, attendeeCount: 1, checkInCount: 1 });

    // the check-in log: one row per entry, with who let them in
    const log = (await request(app).get(`/api/v1/events/${event._id}/checkins?limit=50`).set(auth(tOrg))).body;
    expect(log.data.length).toBe(3);
    expect(log.data.every((r: any) => String(r.checkedInBy?._id || r.checkedInBy) === String(staff._id))).toBe(true);
  });

  it('a repeat scan at a no-restriction session is a repeat entry, not a second attendee', async () => {
    expect((await scan('d', s2._id)).status).toBe(201);
    expect([200, 201]).toContain((await scan('d', s2._id)).status); // Dinner allows repeat entry
    expect(names(await list(`sessionId=${s2._id}&checkInStatus=CHECKED_IN`))).toEqual(['Dev']);
    const rep = (await request(app).get(`/api/v1/reports/events/${event._id}`).set(auth(tOrg))).body.data;
    expect(rep.uniqueAttendees).toBe(1);
    expect(rep.sessionReports.find((r: any) => r.name === 'Dinner').attendeeCount).toBe(1);
  });
});
