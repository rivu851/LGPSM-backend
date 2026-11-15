import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { Notification } from '../src/models/Notification';
import { eventService } from '../src/services/event.service';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60000);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('the assigned system users flow: rules, counts and notices stay consistent', () => {
  let mongo: MongoMemoryServer;
  let org: any, other: any, admin: any, staff: any, staff2: any, tOrg: string, tAdmin: string, event: any, s1: any, s2: any;

  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => {
    await Promise.all([User, Event, Session, SystemUserAssignment, Notification].map((m: any) => m.deleteMany({})));
    const mk = (name: string, role: Role, extra: Record<string, unknown> = {}) => User.create({ fullName: name, email: `${name.replace(/\s/g, '').toLowerCase()}@x.com`, role, isActive: true, ...extra });
    org = await mk('Org', Role.ORGANIZER);
    other = await mk('Other Org', Role.ORGANIZER);
    admin = await mk('Admin', Role.ADMIN);
    staff = await mk('Staff One', Role.SYSTEM_USER, { createdBy: org._id });
    staff2 = await mk('Staff Two', Role.SYSTEM_USER, { createdBy: org._id });
    tOrg = generateAccessToken(String(org._id), org.role);
    tAdmin = generateAccessToken(String(admin._id), admin.role);
    const start = new Date(Date.now() + 864e5);
    event = await Event.create({ organizerId: org._id, title: 'Gala', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, schedule: { start, end: new Date(+start + 8 * 36e5) }, status: EventStatus.PUBLISHED });
    const mkSession = (name: string, h: number) => Session.create({ eventId: event._id, name, schedule: { start: new Date(+start + h * 36e5), end: new Date(+start + (h + 1) * 36e5) }, accessControl: AccessControl.NO_RESTRICTION, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    s1 = await mkSession('Lunch', 1);
    s2 = await mkSession('Dinner', 4);
  });
  const assign = (who: string, userId: any, sessionIds: string[] = []) => request(app).post(`/api/v1/events/${event._id}/assignments`).set(auth(who)).send({ userId: String(userId), sessionIds });
  const noticesOf = async (u: any) => { await new Promise((r) => setTimeout(r, 200)); return (await Notification.find({ userId: u._id }).sort({ createdAt: 1 }).lean()).map((n: any) => n.type); };

  it('only a system user, the event\'s organizer, or the person assigning can be put on an event', async () => {
    expect((await assign(tAdmin, other._id)).status).toBe(400); // some other organizer
    const anotherAdmin = await User.create({ fullName: 'Admin Two', email: 'admin2@x.com', role: Role.ADMIN, isActive: true });
    expect((await assign(tAdmin, anotherAdmin._id)).status).toBe(400); // some other administrator
    expect((await assign(tAdmin, staff._id)).status).toBe(201);
    expect((await assign(tAdmin, admin._id)).status).toBe(201); // an administrator working the event themselves
    expect((await assign(tOrg, org._id)).status).toBe(201); // the organizer working their own event
  });

  it('the staff member is told when they are assigned, when their sessions change, and when they are removed', async () => {
    const made = await assign(tOrg, staff._id, [String(s1._id)]);
    expect(made.status).toBe(201);
    const id = made.body.data._id;
    expect((await request(app).patch(`/api/v1/assignments/${id}`).set(auth(tOrg)).send({ sessionIds: [String(s1._id), String(s2._id)] })).status).toBe(200);
    expect((await request(app).delete(`/api/v1/assignments/${id}`).set(auth(tOrg))).status).toBe(200);
    expect(await noticesOf(staff)).toEqual(['STAFF_ASSIGNED', 'STAFF_CHANGED', 'STAFF_REMOVED']);
    await new Promise((r) => setTimeout(r, 200));
    const first: any = await Notification.findOne({ userId: staff._id, type: 'STAFF_ASSIGNED' }).lean();
    expect(first.message).toMatch(/Gala/);
    expect(first.message).toMatch(/Lunch/);
    // the organizer working their own event is not sent a notice about their own action
    await assign(tOrg, org._id);
    expect(await noticesOf(org)).toEqual([]);
  });

  it('deleting a session takes it off staff assignments: never leaves a stale id, and never widens "some sessions" into "all sessions"', async () => {
    await assign(tOrg, staff._id, [String(s1._id)]); // only Lunch
    await assign(tOrg, staff2._id, [String(s1._id), String(s2._id)]); // Lunch and Dinner
    expect((await request(app).delete(`/api/v1/sessions/${s1._id}`).set(auth(tOrg))).status).toBe(200);
    // the one who was only on Lunch is off the event (not suddenly on every session)
    expect(await SystemUserAssignment.countDocuments({ userId: staff._id, eventId: event._id })).toBe(0);
    // the other keeps Dinner and loses only the dead id
    const rest: any = await SystemUserAssignment.findOne({ userId: staff2._id, eventId: event._id }).lean();
    expect(rest.sessionIds.map(String)).toEqual([String(s2._id)]);
  });

  it('a deactivated staff account is not counted as assigned (event counts and reports)', async () => {
    await assign(tOrg, staff._id);
    await assign(tOrg, staff2._id);
    expect((await eventService.getEventCounts(String(event._id), String(org._id))).assignments).toBe(2);
    await User.updateOne({ _id: staff2._id }, { isActive: false });
    expect((await eventService.getEventCounts(String(event._id), String(org._id))).assignments).toBe(1);
  });

  it('refuses a duplicate, sessions of another event, and a cancelled event', async () => {
    expect((await assign(tOrg, staff._id)).status).toBe(201);
    expect((await assign(tOrg, staff._id)).status).toBe(409);
    const foreign = await Event.create({ organizerId: org._id, title: 'Other', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) }, status: EventStatus.PUBLISHED });
    const foreignSession = await Session.create({ eventId: foreign._id, name: 'X', schedule: { start: foreign.schedule.start, end: foreign.schedule.end }, accessControl: AccessControl.NO_RESTRICTION, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    expect((await assign(tOrg, staff2._id, [String(foreignSession._id)])).status).toBe(400);
    await Event.updateOne({ _id: event._id }, { status: EventStatus.CANCELLED });
    expect((await assign(tOrg, staff2._id)).status).toBe(409);
  });
});
