import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { generateAccessToken } from '../src/utils/token';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

// What the "assign selected users to an event" action on User Management calls: one POST per selected user.
describe('assigning staff to events (bulk selection on User Management)', () => {
  let mongo: MongoMemoryServer;
  let orgA: any, orgB: any, admin: any, tA: string, tB: string, tAdmin: string, tStaff: string;
  let staffA: any[], staffB: any, inactive: any, eventA: any, eventB: any, session: any;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    await Promise.all([User, Event, Session, SystemUserAssignment].map((m: any) => m.deleteMany({})));
    const mk = (name: string, role: Role, extra: Record<string, unknown> = {}) => User.create({ fullName: name, email: `${name.replace(/\s/g, '').toLowerCase()}@x.com`, role, isActive: true, ...extra });
    orgA = await mk('Org A', Role.ORGANIZER);
    orgB = await mk('Org B', Role.ORGANIZER);
    admin = await mk('Admin', Role.ADMIN);
    staffA = [await mk('Staff 1', Role.SYSTEM_USER, { createdBy: orgA._id }), await mk('Staff 2', Role.SYSTEM_USER, { createdBy: orgA._id }), await mk('Staff 3', Role.SYSTEM_USER, { createdBy: orgA._id })];
    staffB = await mk('Staff of B', Role.SYSTEM_USER, { createdBy: orgB._id });
    inactive = await mk('Gone Staff', Role.SYSTEM_USER, { createdBy: orgA._id, isActive: false });
    tA = generateAccessToken(String(orgA._id), orgA.role);
    tB = generateAccessToken(String(orgB._id), orgB.role);
    tAdmin = generateAccessToken(String(admin._id), admin.role);
    tStaff = generateAccessToken(String(staffA[0]._id), staffA[0].role);
    const mkEvent = (organizerId: any, title: string) => Event.create({ organizerId, title, description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) }, status: EventStatus.PUBLISHED });
    eventA = await mkEvent(orgA._id, 'A event');
    eventB = await mkEvent(orgB._id, 'B event');
    session = await Session.create({ eventId: eventA._id, name: 'Main', schedule: { start: eventA.schedule.start, end: eventA.schedule.end }, accessControl: AccessControl.NO_RESTRICTION, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
  });

  const assign = (who: string, eventId: any, userId: any, sessionIds: string[] = []) =>
    request(app).post(`/api/v1/events/${eventId}/assignments`).set(auth(who)).send({ userId: String(userId), sessionIds });

  it('an organizer assigns several of their own staff to their own event, one request per selected user', async () => {
    const results = await Promise.all(staffA.map((u) => assign(tA, eventA._id, u._id)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await SystemUserAssignment.countDocuments({ eventId: eventA._id })).toBe(3);
  });

  it('a partly failing selection saves the valid users and reports the others (duplicate, inactive)', async () => {
    await assign(tA, eventA._id, staffA[0]._id);
    const results = await Promise.all([staffA[0], staffA[1], inactive].map((u) => assign(tA, eventA._id, u._id)));
    expect(results.map((r) => r.status)).toEqual([409, 201, 400]);
    expect(await SystemUserAssignment.countDocuments({ eventId: eventA._id })).toBe(2);
  });

  it('cannot assign another organizer\'s staff (cross-organizer), even to one\'s own event', async () => {
    const res = await assign(tA, eventA._id, staffB._id);
    expect(res.status).toBe(400);
    expect(await SystemUserAssignment.countDocuments()).toBe(0);
  });

  it('cannot assign to another organizer\'s event', async () => {
    const res = await assign(tA, eventB._id, staffA[0]._id);
    expect(res.status).toBe(404);
    expect((await assign(tB, eventA._id, staffB._id)).status).toBe(404);
    expect(await SystemUserAssignment.countDocuments()).toBe(0);
  });

  it('a system user cannot assign anyone, and anonymous callers are refused', async () => {
    expect((await assign(tStaff, eventA._id, staffA[1]._id)).status).toBe(403);
    expect((await request(app).post(`/api/v1/events/${eventA._id}/assignments`).send({ userId: String(staffA[1]._id) })).status).toBe(401);
  });

  it('a session limit must belong to the event', async () => {
    const foreign = await Session.create({ eventId: eventB._id, name: 'Other', schedule: { start: eventB.schedule.start, end: eventB.schedule.end }, accessControl: AccessControl.NO_RESTRICTION, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    expect((await assign(tA, eventA._id, staffA[0]._id, [String(foreign._id)])).status).toBe(400);
    expect((await assign(tA, eventA._id, staffA[0]._id, [String(session._id)])).status).toBe(201);
  });

  it('an administrator may assign across tenants', async () => {
    expect((await assign(tAdmin, eventB._id, staffB._id)).status).toBe(201);
  });

  it('staff cannot be assigned to a cancelled event, so it never looks like live work', async () => {
    await Event.updateOne({ _id: eventA._id }, { status: EventStatus.CANCELLED });
    const res = await assign(tA, eventA._id, staffA[0]._id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVENT_CANCELLED');
    expect(await SystemUserAssignment.countDocuments()).toBe(0);
  });
});
