import mongoose from 'mongoose';
import supertest from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { TicketTier } from '../src/models/TicketTier';
import { generateAccessToken } from '../src/utils/token';

// Audit finding F-01: GET /events/:id/tickets returned another organizer's ticket prices and sales to any signed-in user.
const request = supertest(app);
jest.setTimeout(60_000);

describe('ticket tier listing is limited to the event owner and admins', () => {
  let mongo: MongoMemoryServer;
  let admin: any, orgA: any, orgB: any, staff: any, eventA: any;
  const bearer = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
  const mk = (name: string, role: Role, extra = {}) => User.create({ fullName: name, email: `${name.replace(/\W/g, '').toLowerCase()}@t.test`, role, passwordHash: 'x', isActive: true, ...extra });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    admin = await mk('Admin One', Role.ADMIN); orgA = await mk('Org A', Role.ORGANIZER); orgB = await mk('Org B', Role.ORGANIZER); staff = await mk('Staff A', Role.SYSTEM_USER, { createdBy: orgA._id });
    eventA = await Event.create({ organizerId: orgA._id, title: 'A event', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: 'x', coordinates: [0, 0] } as any, schedule: { start: new Date(), end: new Date(Date.now() + 3600e3) } });
    await TicketTier.create({ eventId: eventA._id, name: 'VIP', price: 5000, capacity: 10, sold: 3 });
    await TicketTier.create({ eventId: eventA._id, name: 'Retired', price: 100, capacity: 5, isActive: false });
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  const url = (id: any) => `/api/v1/events/${id}/tickets`;

  it('the owner sees the active tiers', async () => {
    const res = await request.get(url(eventA._id)).set(bearer(orgA));
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: any) => t.name)).toEqual(['VIP']);
    expect(res.body.data[0].price).toBe(5000);
  });
  it('the owner can ask for inactive tiers too', async () => {
    const res = await request.get(`${url(eventA._id)}?activeOnly=false`).set(bearer(orgA));
    expect(res.body.data).toHaveLength(2);
  });
  it('an admin sees any event\'s tiers', async () => {
    const res = await request.get(url(eventA._id)).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
  it('another organizer is told the event does not exist, and receives no tier data', async () => {
    const res = await request.get(url(eventA._id)).set(bearer(orgB));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/VIP|5000|capacity|sold/);
  });
  it('a system user (even one of the owner\'s) may not list ticket tiers', async () => {
    const res = await request.get(url(eventA._id)).set(bearer(staff));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/VIP|5000/);
  });
  it('an unauthenticated request is refused', async () => {
    expect((await request.get(url(eventA._id))).status).toBe(401);
  });
  it('a malformed id is a 400 and a well-formed unknown id is a 404 (for the owner and for an admin)', async () => {
    expect((await request.get(url('not-an-id')).set(bearer(orgA))).status).toBe(400);
    const ghost = new mongoose.Types.ObjectId();
    expect((await request.get(url(ghost)).set(bearer(orgA))).status).toBe(404);
    expect((await request.get(url(ghost)).set(bearer(admin))).status).toBe(404);
  });
  it('writing is unchanged: only the owner or an admin may add a tier', async () => {
    expect((await request.post(url(eventA._id)).set(bearer(orgB)).send({ name: 'x', price: 1, capacity: 1 })).status).toBe(404);
    expect((await request.post(url(eventA._id)).set(bearer(orgA)).send({ name: 'Early', price: 1, capacity: 1 })).status).toBe(201);
  });
});
