/**
 * Sessions are part of what a finished event records: once an event is over (closed, cancelled, or its end time has passed) a session
 * can no longer be added, renamed or deleted. An event still to come is unaffected.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60_000);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const HOUR = 3600e3;

describe('a session of an event that is over cannot be added, changed or deleted', () => {
  let mongo: MongoMemoryServer; let org: any; let admin: any; let tOrg = ''; let tAdmin = '';
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeAll(async () => {
    org = await User.create({ fullName: 'Org', email: 'over.org@x.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
    admin = await User.create({ fullName: 'Admin', email: 'over.admin@x.com', role: Role.ADMIN, isActive: true });
    tOrg = generateAccessToken(String(org._id), org.role);
    tAdmin = generateAccessToken(String(admin._id), admin.role);
  });

  const make = async (start: number, end: number, status = EventStatus.PUBLISHED) => {
    const event: any = await Event.create({ organizerId: org._id, title: 'E', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, contactNumber: '123456789', schedule: { start: new Date(start), end: new Date(end) }, status });
    const session: any = await Session.create({ eventId: event._id, name: 'Lunch', schedule: event.schedule, accessControl: AccessControl.ONLY_ONCE, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    return { event, session };
  };
  const body = (event: any) => ({ name: 'New', schedule: { start: event.schedule.start, end: event.schedule.end }, accessControl: 'ONLY_ONCE', validateAgainstOtherSessions: false, inviteeSource: 'NEW_LIST' });

  it('refuses to add, rename or delete once the end time has passed (the status is still published)', async () => {
    const { event, session } = await make(Date.now() - 5 * HOUR, Date.now() - 2 * HOUR);
    for (const t of [tOrg, tAdmin]) {
      const add = await request(app).post(`/api/v1/events/${event._id}/sessions`).set(auth(t)).send(body(event));
      expect(add.status).toBe(409);
      expect(add.body.code ?? add.body.error?.code).toBe('EVENT_ENDED');
      expect((await request(app).patch(`/api/v1/sessions/${session._id}`).set(auth(t)).send({ name: 'Renamed' })).status).toBe(409);
      expect((await request(app).delete(`/api/v1/sessions/${session._id}`).set(auth(t))).status).toBe(409);
    }
    expect((await Session.findById(session._id).lean() as any).name).toBe('Lunch');
  });

  it('refuses the same for a closed event', async () => {
    const { event, session } = await make(Date.now() + HOUR, Date.now() + 3 * HOUR, EventStatus.COMPLETED);
    expect((await request(app).patch(`/api/v1/sessions/${session._id}`).set(auth(tOrg)).send({ name: 'Renamed' })).status).toBe(409);
    expect((await request(app).post(`/api/v1/events/${event._id}/sessions`).set(auth(tOrg)).send(body(event))).status).toBe(409);
  });

  it('still lets an event that is yet to come, or running now, change its sessions', async () => {
    const upcoming = await make(Date.now() + 2 * HOUR, Date.now() + 5 * HOUR);
    expect((await request(app).patch(`/api/v1/sessions/${upcoming.session._id}`).set(auth(tOrg)).send({ name: 'Renamed' })).status).toBe(200);
    const running = await make(Date.now() - HOUR, Date.now() + 3 * HOUR);
    expect((await request(app).patch(`/api/v1/sessions/${running.session._id}`).set(auth(tOrg)).send({ name: 'Renamed' })).status).toBe(200);
  });
});

describe('an event that is already over cannot be cancelled (it is deleted instead)', () => {
  let mongo: MongoMemoryServer; let org: any; let tOrg = '';
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); org = await User.create({ fullName: 'Org2', email: 'over2.org@x.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true }); tOrg = generateAccessToken(String(org._id), org.role); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('refuses to cancel a finished event, and still cancels one that is yet to come', async () => {
    const mk = (start: number, end: number) => Event.create({ organizerId: org._id, title: 'C', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, contactNumber: '123456789', schedule: { start: new Date(start), end: new Date(end) }, status: EventStatus.PUBLISHED });
    const over: any = await mk(Date.now() - 5 * HOUR, Date.now() - 2 * HOUR);
    const cancelOver = await request(app).post(`/api/v1/events/${over._id}/cancel`).set(auth(tOrg)).send({});
    expect(cancelOver.status).toBe(409);
    expect((await Event.findById(over._id).lean() as any).status).toBe(EventStatus.PUBLISHED);
    const upcoming: any = await mk(Date.now() + 2 * HOUR, Date.now() + 5 * HOUR);
    expect((await request(app).post(`/api/v1/events/${upcoming._id}/cancel`).set(auth(tOrg)).send({})).status).toBe(200);
  });
});
