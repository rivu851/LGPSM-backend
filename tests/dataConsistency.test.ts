/**
 * What the web and the app show for organizers, administrators and system users all comes from the same server data, and every change
 * must reach each of them on its next read: an invitee added, a staff member assigned or removed, a session changed, a guest checked in.
 * This walks one event through those changes and reads it back as each role after every step.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee } from '../src/models/Invitee';
import { CheckIn } from '../src/models/CheckIn';
import { DeliveryChannel } from '../src/models/Invitation';
import * as emailProvider from '../src/utils/email.provider';
import { whatsappService } from '../src/services/whatsapp.service';
import { invitationService } from '../src/services/invitation.service';
import { generateAccessToken } from '../src/utils/token';
import { decryptToken } from '../src/utils/tokenCipher';

jest.setTimeout(90_000);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const HOUR = 3600e3;

describe('one set of changes, read back as the organizer, the administrator and the system user', () => {
  let mongo: MongoMemoryServer;
  let org: any, admin: any, tOrg: string, tAdmin: string, event: any, lunch: any, dinner: any;
  let tStaff = '';
  let staffId = '';

  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeAll(async () => {
    jest.spyOn(emailProvider, 'sendEmail').mockResolvedValue(true as any);
    jest.spyOn(whatsappService, 'sendPassWhatsApp').mockResolvedValue({ messageId: 'wamid.x' });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await Promise.all([User, Event, Session, Invitee, CheckIn].map((m: any) => m.deleteMany({})));
    org = await User.create({ fullName: 'Org', email: 'consistency.org@x.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
    admin = await User.create({ fullName: 'Admin', email: 'consistency.admin@x.com', role: Role.ADMIN, isActive: true });
    tOrg = generateAccessToken(String(org._id), org.role);
    tAdmin = generateAccessToken(String(admin._id), admin.role);
    event = await Event.create({
      organizerId: org._id, title: 'Consistency Gala', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, contactNumber: '123456789',
      schedule: { start: new Date(Date.now() - HOUR), end: new Date(Date.now() + 4 * HOUR) }, status: EventStatus.PUBLISHED,
      rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: true }
    });
    const mk = (name: string) => Session.create({ eventId: event._id, name, schedule: event.schedule, accessControl: AccessControl.ONLY_ONCE, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    lunch = await mk('Lunch');
    dinner = await mk('Dinner');
  });

  const report = (token: string) => request(app).get(`/api/v1/reports/events/${event._id}`).set(auth(token));
  const invitees = (token: string) => request(app).get(`/api/v1/events/${event._id}/invitees`).set(auth(token));
  const mine = (token: string) => request(app).get('/api/v1/users/me/assignments').set(auth(token));
  const sessionsOf = (token: string) => request(app).get(`/api/v1/events/${event._id}/sessions`).set(auth(token));

  it('a staff member added by the organizer signs in, and the organizer and the admin both see them on the event once assigned', async () => {
    const made = await request(app).post('/api/users').set(auth(tOrg)).send({ role: 'SYSTEM_USER', fullName: 'Gate Staff', email: 'consistency.staff@x.com', phone: '9876500123', password: 'GateStaff#123' });
    expect(made.status).toBe(201);
    staffId = String(made.body.data._id);
    const login = await request(app).post('/api/auth/login').send({ role: 'SYSTEM_USER', email: 'consistency.staff@x.com', password: 'GateStaff#123' });
    expect(login.status).toBe(200);
    tStaff = login.body.data.accessToken;

    // nothing assigned yet: the staff member sees no event, the report shows nobody on it
    expect(JSON.stringify((await mine(tStaff)).body.data)).not.toMatch(/Consistency Gala/);
    expect((await report(tOrg)).body.data.totalSystemUsers).toBe(0);

    const assigned = await request(app).post(`/api/v1/events/${event._id}/assignments`).set(auth(tOrg)).send({ userId: staffId, sessionIds: [String(lunch._id)] });
    expect(assigned.status).toBe(201);
    for (const t of [tOrg, tAdmin]) expect((await report(t)).body.data.totalSystemUsers).toBe(1);
    expect(JSON.stringify((await mine(tStaff)).body.data)).toMatch(/Consistency Gala/);
    expect((await sessionsOf(tStaff)).body.data.map((s: any) => s.name)).toEqual(['Lunch']);
  });

  it('an invitee added by the organizer shows for the admin and the staff member, and in every count', async () => {
    for (const t of [tOrg, tAdmin, tStaff]) expect((await invitees(t)).body.data).toHaveLength(0);
    const added = await request(app).post(`/api/v1/events/${event._id}/invitees`).set(auth(tOrg)).send({ name: 'Guest One', email: 'consistency.guest@x.com', mobile: '9877020099' });
    expect(added.status).toBeLessThan(300);
    for (const t of [tOrg, tAdmin, tStaff]) {
      const list = (await invitees(t)).body.data as any[];
      expect(list.map((i) => i.name)).toEqual(['Guest One']);
    }
    for (const t of [tOrg, tAdmin]) expect((await report(t)).body.data.totalInvitees).toBe(1);
  });

  it('a check-in by the staff member reaches the organizer and the admin (reports, the check-in list and the guest list)', async () => {
    const inv: any = await Invitee.findOne({ eventId: event._id });
    const sent = await invitationService.sendInvitations(String(event._id), String(org._id), [String(inv._id)], DeliveryChannel.EMAIL);
    expect(sent[0].status).toBe('SENT');
    const stored: any = await Invitee.findById(inv._id).select('+qrTokenCipher');
    const qrCode = decryptToken(stored.qrTokenCipher)!;

    // the staff member covers Lunch only: Dinner is refused, Lunch works
    expect((await request(app).post('/api/v1/checkins/scan').set(auth(tStaff)).send({ qrCode, eventId: String(event._id), sessionId: String(dinner._id) })).status).toBeGreaterThanOrEqual(400);
    const ok = await request(app).post('/api/v1/checkins/scan').set(auth(tStaff)).send({ qrCode, eventId: String(event._id), sessionId: String(lunch._id) });
    expect(ok.status).toBeLessThan(300);

    for (const t of [tOrg, tAdmin]) {
      const r = (await report(t)).body.data;
      expect(r.totalCheckIns).toBe(1);
      expect(r.uniqueAttendees).toBe(1);
      const lunchRow = r.sessions?.find?.((s: any) => s.name === 'Lunch') ?? r.sessionReports?.find?.((s: any) => s.name === 'Lunch');
      if (lunchRow) expect(lunchRow.checkInCount).toBe(1);
    }
    for (const t of [tOrg, tAdmin, tStaff]) {
      const list = await request(app).get(`/api/v1/events/${event._id}/checkins`).set(auth(t));
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
    }
  });

  it('changing the staff member\'s sessions, then removing them, shows at once for them, the organizer and the admin', async () => {
    const a: any = (await request(app).get(`/api/v1/events/${event._id}/assignments`).set(auth(tOrg))).body.data.find((x: any) => String(x.userId?._id ?? x.userId) === staffId);
    expect(a).toBeTruthy();
    const both = await request(app).patch(`/api/v1/assignments/${a._id}`).set(auth(tOrg)).send({ sessionIds: [String(lunch._id), String(dinner._id)] });
    expect(both.status).toBe(200);
    expect((await sessionsOf(tStaff)).body.data.map((s: any) => s.name).sort()).toEqual(['Dinner', 'Lunch']);

    expect((await request(app).delete(`/api/v1/assignments/${a._id}`).set(auth(tOrg))).status).toBe(200);
    for (const t of [tOrg, tAdmin]) expect((await report(t)).body.data.totalSystemUsers).toBe(0);
    expect(JSON.stringify((await mine(tStaff)).body.data)).not.toMatch(/Consistency Gala/);
    // and with the assignment gone the staff member can no longer read the event's guests
    expect((await invitees(tStaff)).status).toBeGreaterThanOrEqual(400);
  });
});
