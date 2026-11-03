import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Session } from '../src/models/Session';
import { Invitee } from '../src/models/Invitee';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { generateAccessToken } from '../src/utils/token';

const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });

describe('GET /events/:eventId/counts (the tab strip totals in one call)', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => { await Promise.all([User.deleteMany({}), Event.deleteMany({}), Session.deleteMany({}), Invitee.deleteMany({}), SystemUserAssignment.deleteMany({})]); });

  const mkUser = (name: string, role: Role) => User.create({ fullName: name, email: `${name}@x.com`, role, isActive: true });
  const mkEvent = (organizerId: any) => Event.create({
    organizerId, title: 'E', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL' as any,
    location: { type: 'Point', address: 'Hall', coordinates: [0, 0] } as any,
    schedule: { start: new Date('2031-03-03T10:00:00Z'), end: new Date('2031-03-03T12:00:00Z') }, status: 'PUBLISHED'
  } as any);

  it('returns the number of sessions, invitees (set-aside guests left out) and assigned staff', async () => {
    const org = await mkUser('org', Role.ORGANIZER); const staff = await mkUser('staff', Role.SYSTEM_USER); const other = await mkUser('other', Role.ORGANIZER);
    const ev = await mkEvent(org._id);
    await Session.create([
      { eventId: ev._id, name: 'S1', schedule: { start: new Date('2031-03-03T10:00:00Z'), end: new Date('2031-03-03T11:00:00Z') } },
      { eventId: ev._id, name: 'S2', schedule: { start: new Date('2031-03-03T11:00:00Z'), end: new Date('2031-03-03T12:00:00Z') } },
    ] as any);
    await Invitee.create([
      { eventId: ev._id, name: 'A', email: 'a@x.com' },
      { eventId: ev._id, name: 'B', email: 'b@x.com' },
      { eventId: ev._id, name: 'Set aside', email: 'c@x.com', archivedAt: new Date() },
    ] as any);
    await SystemUserAssignment.create({ userId: staff._id, eventId: ev._id, sessionIds: [], assignedBy: org._id });

    const res = await request(app).get(`/api/v1/events/${ev._id}/counts`).set(auth(org));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sessions: 2, invitees: 2, assignments: 1 });

    // another organizer cannot read this event's totals; a system user is not allowed on this route
    expect((await request(app).get(`/api/v1/events/${ev._id}/counts`).set(auth(other))).status).toBe(404);
    expect((await request(app).get(`/api/v1/events/${ev._id}/counts`).set(auth(staff))).status).toBe(403);
    expect((await request(app).get(`/api/v1/events/${ev._id}/counts`)).status).toBe(401);
  });
});
