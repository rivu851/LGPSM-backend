import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { generateAccessToken } from '../src/utils/token';

const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
const at = (h: number) => new Date(`2031-03-03T${String(h).padStart(2, '0')}:00:00.000Z`);

describe('staff already assigned to another event at the same time', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => { await Promise.all([User.deleteMany({}), Event.deleteMany({}), SystemUserAssignment.deleteMany({})]); });

  const mkUser = (name: string, role: Role) => User.create({ fullName: name, email: `${name}@x.com`, role, isActive: true });
  const mkEvent = (organizerId: any, title: string, start: number, end: number, status = 'PUBLISHED') => Event.create({
    organizerId, title, description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL' as any,
    location: { type: 'Point', address: 'Hall', coordinates: [0, 0] } as any, schedule: { start: at(start), end: at(end) }, status
  } as any);

  it('lists the overlapping events of the same organizer, and nothing else', async () => {
    const org = await mkUser('org', Role.ORGANIZER); const other = await mkUser('other', Role.ORGANIZER); const staff = await mkUser('staff', Role.SYSTEM_USER);
    const a = await mkEvent(org._id, 'Event A', 10, 12);
    const overlapping = await mkEvent(org._id, 'Event B', 11, 13);
    const later = await mkEvent(org._id, 'Event C', 14, 16);
    const cancelled = await mkEvent(org._id, 'Event D', 10, 12, 'CANCELLED');
    const foreign = await mkEvent(other._id, 'Event E', 10, 12);
    for (const e of [overlapping, later, cancelled, foreign]) await SystemUserAssignment.create({ userId: staff._id, eventId: e._id, sessionIds: [], assignedBy: org._id });

    const res = await request(app).get(`/api/v1/events/${a._id}/assignments/overlaps`).set(auth(org));
    expect(res.status).toBe(200);
    expect(res.body.data.map((x: any) => [x.userId, x.title])).toEqual([[String(staff._id), 'Event B']]);

    const admin = await mkUser('admin', Role.ADMIN);
    expect((await request(app).get(`/api/v1/events/${a._id}/assignments/overlaps`).set(auth(admin))).body.data).toHaveLength(1);
    // another organizer cannot ask about this event
    expect((await request(app).get(`/api/v1/events/${a._id}/assignments/overlaps`).set(auth(other))).status).toBe(404);
  });
  it("with ?all=1 returns every assignment on the organizer's other events and says which ones overlap", async () => {
    const org = await mkUser('org', Role.ORGANIZER); const other = await mkUser('other', Role.ORGANIZER); const staff = await mkUser('staff', Role.SYSTEM_USER);
    const a = await mkEvent(org._id, 'Event A', 10, 12);
    const overlapping = await mkEvent(org._id, 'Event B', 11, 13);
    const later = await mkEvent(org._id, 'Event C', 14, 16);
    const cancelled = await mkEvent(org._id, 'Event D', 10, 12, 'CANCELLED');
    const foreign = await mkEvent(other._id, 'Event E', 10, 12);
    for (const e of [overlapping, later, cancelled, foreign]) await SystemUserAssignment.create({ userId: staff._id, eventId: e._id, sessionIds: [], assignedBy: org._id });

    const res = await request(app).get(`/api/v1/events/${a._id}/assignments/overlaps?all=1`).set(auth(org));
    expect(res.status).toBe(200);
    const byTitle = Object.fromEntries(res.body.data.map((x: any) => [x.title, x.overlaps]));
    expect(byTitle).toEqual({ 'Event B': true, 'Event C': false });
    expect(res.body.data.every((x: any) => Array.isArray(x.sessionIds) && x.userId === String(staff._id))).toBe(true);
    // the default mode is unchanged: only the overlapping one
    const plain = await request(app).get(`/api/v1/events/${a._id}/assignments/overlaps`).set(auth(org));
    expect(plain.body.data.map((x: any) => x.title)).toEqual(['Event B']);
  });
});
