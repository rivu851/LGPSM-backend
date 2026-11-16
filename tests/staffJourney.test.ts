/**
 * The whole journey of a system user added from the web or the app: added with details, signs in to the mobile app with them, finds the
 * events and sessions they were assigned, and scans guests' QR codes to check them in.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee, RsvpStatus } from '../src/models/Invitee';
import { CheckIn } from '../src/models/CheckIn';
import { DeliveryChannel } from '../src/models/Invitation';
import * as emailProvider from '../src/utils/email.provider';
import { whatsappService } from '../src/services/whatsapp.service';
import { invitationService } from '../src/services/invitation.service';
import { generateAccessToken } from '../src/utils/token';
import { decryptToken } from '../src/utils/tokenCipher';

jest.setTimeout(60_000);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const HOUR = 3600e3;

describe('a system user added with details can sign in, see their events and sessions, and check guests in', () => {
  let mongo: MongoMemoryServer;
  let org: any, admin: any, tOrg: string, tAdmin: string, event: any, lunch: any, dinner: any, emailSpy: jest.SpyInstance;

  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([User, Event, Session, Invitee, CheckIn].map((m: any) => m.deleteMany({})));
    org = await User.create({ fullName: 'Org', email: 'journey.org@x.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
    admin = await User.create({ fullName: 'Admin', email: 'journey.admin@x.com', role: Role.ADMIN, isActive: true });
    tOrg = generateAccessToken(String(org._id), org.role);
    tAdmin = generateAccessToken(String(admin._id), admin.role);
    event = await Event.create({
      organizerId: org._id, title: 'Journey Gala', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, contactNumber: '123456789',
      schedule: { start: new Date(Date.now() - HOUR), end: new Date(Date.now() + 4 * HOUR) }, status: EventStatus.PUBLISHED,
      rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: true }
    });
    const mkSession = (name: string) => Session.create({ eventId: event._id, name, schedule: event.schedule, accessControl: AccessControl.ONLY_ONCE, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    lunch = await mkSession('Lunch');
    dinner = await mkSession('Dinner');
    emailSpy = jest.spyOn(emailProvider, 'sendEmail').mockResolvedValue(true as any);
    jest.spyOn(whatsappService, 'sendPassWhatsApp').mockResolvedValue({ messageId: 'wamid.x' });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const addStaff = (who: string, body: Record<string, unknown>) => request(app).post('/api/users').set(auth(who)).send({ role: 'SYSTEM_USER', ...body });
  const signIn = (body: Record<string, unknown>) => request(app).post('/api/auth/login').send({ role: 'SYSTEM_USER', ...body });

  async function guest() {
    const inv: any = await Invitee.create({ eventId: event._id, name: 'Guest One', email: 'guest.one@x.com', mobile: '9877020001', rsvpStatus: RsvpStatus.ACCEPTED, sessionAccess: [] });
    const results = await invitationService.sendInvitations(String(event._id), String(org._id), [String(inv._id)], DeliveryChannel.EMAIL);
    expect(results[0].status).toBe('SENT');
    const stored: any = await Invitee.findById(inv._id).select('+qrTokenCipher');
    return { id: String(inv._id), admission: decryptToken(stored.qrTokenCipher)! };
  }

  it.each([['an organizer', 'org'], ['an administrator', 'admin']] as const)('added by %s with a password: signs in by email or by mobile number, sees only the assigned session, and scans a guest in', async (_who, which) => {
    const adder = which === 'org' ? tOrg : tAdmin;
    const made = await addStaff(adder, { fullName: 'Gate Keeper', email: 'gate.keeper@x.com', phone: '9876543210', password: 'GateKeeper#123', ...(which === 'admin' ? { organizerId: String(org._id) } : {}) });
    expect(made.status).toBe(201);

    // the details they were added with are the login
    const byEmail = await signIn({ email: 'gate.keeper@x.com', password: 'GateKeeper#123' });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.user.role).toBe('SYSTEM_USER');
    expect((await signIn({ phone: '9876543210', password: 'GateKeeper#123' })).status).toBe(200);
    expect((await signIn({ email: 'gate.keeper@x.com', password: 'wrong-password' })).status).toBe(401);
    // a staff account is not an organizer account
    expect((await request(app).post('/api/auth/login').send({ email: 'gate.keeper@x.com', password: 'GateKeeper#123', role: 'ORGANIZER' })).status).toBe(403);
    const tStaff = byEmail.body.data.accessToken as string;
    const staffId = String(made.body.data._id || made.body.data.id);

    // nothing yet: no event
    const none = await request(app).get('/api/v1/users/me/assignments').set(auth(tStaff));
    expect(none.status).toBe(200);
    expect(JSON.stringify(none.body.data)).not.toMatch(/Journey Gala/);

    // assigned to the Lunch session only
    const assigned = await request(app).post(`/api/v1/events/${event._id}/assignments`).set(auth(tOrg)).send({ userId: staffId, sessionIds: [String(lunch._id)] });
    expect(assigned.status).toBe(201);
    const mine = await request(app).get('/api/v1/users/me/assignments').set(auth(tStaff));
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body.data)).toMatch(/Journey Gala/);
    expect((await request(app).get(`/api/v1/events/${event._id}`).set(auth(tStaff))).status).toBe(200);
    const sessions = await request(app).get(`/api/v1/events/${event._id}/sessions`).set(auth(tStaff));
    expect(sessions.status).toBe(200);
    const names = (sessions.body.data as any[]).map((s) => s.name);
    expect(names).toEqual(['Lunch']);

    // scanning: allowed in their session, refused in one that is not theirs
    const g = await guest();
    const wrongSession = await request(app).post('/api/v1/checkins/scan').set(auth(tStaff)).send({ qrCode: g.admission, eventId: String(event._id), sessionId: String(dinner._id) });
    expect(wrongSession.status).toBeGreaterThanOrEqual(400);
    const ok = await request(app).post('/api/v1/checkins/scan').set(auth(tStaff)).send({ qrCode: g.admission, eventId: String(event._id), sessionId: String(lunch._id) });
    expect(ok.status).toBeLessThan(300);
    expect(await CheckIn.countDocuments({ inviteeId: g.id })).toBe(1);
  });

  it('added without a password: a password is generated and emailed with the login email, and it works in the app', async () => {
    const made = await addStaff(tOrg, { fullName: 'Door Person', email: 'door.person@x.com', phone: '9876543211' });
    expect(made.status).toBe(201);
    const mail = emailSpy.mock.calls.find((c) => c[0] === 'door.person@x.com');
    expect(mail).toBeTruthy();
    const html = String(mail![2]);
    const password = html.match(/font-family:monospace[^>]*>([^<]+)</)?.[1];
    expect(password).toBeTruthy();
    expect((await signIn({ email: 'door.person@x.com', password: password! })).status).toBe(200);
  });
});
