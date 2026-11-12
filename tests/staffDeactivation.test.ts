import mongoose from 'mongoose';
import supertest from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { generateAccessToken, generateRefreshToken } from '../src/utils/token';
import { hashPassword } from '../src/utils/password';

// Audit finding F-03: an organizer's PATCH {isActive:false} on their staff answered 200 and changed nothing.
const request = supertest(app);
jest.setTimeout(60_000);

describe('deactivating staff: the answer matches what happened', () => {
  let mongo: MongoMemoryServer; let admin: any, orgA: any, orgB: any, event: any;
  const bearer = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
  const PW = 'StaffPass1234!';
  const mkStaff = async (n: string, owner: any) => User.create({ fullName: n, email: `${n.toLowerCase().replace(/\W/g, '')}@d.test`, role: Role.SYSTEM_USER, passwordHash: await hashPassword(PW), isActive: true, createdBy: owner._id, phone: '9190' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0') });
  const login = (u: any) => request.post('/api/auth/login').send({ email: u.email, password: PW, role: 'SYSTEM_USER' });
  const active = async (u: any) => (await User.findById(u._id))!.isActive;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    const mk = (n: string, role: Role) => User.create({ fullName: n, email: `${n.replace(/\W/g, '').toLowerCase()}@d.test`, role, passwordHash: 'x', isActive: true });
    admin = await mk('Admin One', Role.ADMIN); orgA = await mk('Org A', Role.ORGANIZER); orgB = await mk('Org B', Role.ORGANIZER);
    event = await Event.create({ organizerId: orgA._id, title: 'A', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: 'x', coordinates: [0, 0] } as any, schedule: { start: new Date(Date.now() - 3600e3), end: new Date(Date.now() + 86400e3) }, status: 'PUBLISHED' });
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('the owning organizer deactivates their staff member with PATCH: state changes, sign-in and tokens stop, assignment is kept', async () => {
    const s = await mkStaff('Staff One', orgA); await SystemUserAssignment.create({ userId: s._id, eventId: event._id, sessionIds: [], assignedBy: orgA._id });
    const before = await login(s); expect(before.status).toBe(200);
    const res = await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
    expect(await active(s)).toBe(false);
    expect([401, 403]).toContain((await login(s)).status);
    const refused = await request.get(`/api/v1/events/${event._id}`).set(bearer(s));
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCOUNT_INACTIVE'); // lets a client tell "your account was switched off" from "not allowed here"
    expect((await request.post('/api/auth/refresh').send({ refreshToken: before.body.data.refreshToken })).status).toBeGreaterThanOrEqual(401);
    expect(await SystemUserAssignment.countDocuments({ userId: s._id })).toBe(1); // deactivation is not deletion
    expect(await User.exists({ _id: s._id })).toBeTruthy();
  });
  it('repeating the deactivation is harmless', async () => {
    const s = await mkStaff('Staff Two', orgA);
    expect((await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ isActive: false })).status).toBe(200);
    expect((await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ isActive: false })).status).toBe(200);
    expect(await active(s)).toBe(false);
  });
  it('another organizer cannot deactivate this organizer\'s staff, and nothing changes', async () => {
    const s = await mkStaff('Staff Three', orgA);
    const res = await request.patch(`/api/users/${s._id}`).set(bearer(orgB)).send({ isActive: false });
    expect([403, 404]).toContain(res.status);
    expect(await active(s)).toBe(true);
  });
  it('an organizer asking to REactivate is told no, honestly, and the account stays off', async () => {
    const s = await mkStaff('Staff Four', orgA);
    await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ isActive: false });
    const res = await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ isActive: true });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/administrator/i);
    expect(await active(s)).toBe(false);
  });
  it('an admin can deactivate and reactivate any staff member', async () => {
    const s = await mkStaff('Staff Five', orgA);
    expect((await request.patch(`/api/users/${s._id}`).set(bearer(admin)).send({ isActive: false })).status).toBe(200);
    expect(await active(s)).toBe(false);
    expect([401, 403]).toContain((await login(s)).status);
    expect((await request.patch(`/api/users/${s._id}`).set(bearer(admin)).send({ isActive: true })).status).toBe(200);
    expect(await active(s)).toBe(true);
    expect((await login(s)).status).toBe(200);
  });
  it('an organizer cannot deactivate an organizer or an admin account', async () => {
    expect([403, 404]).toContain((await request.patch(`/api/users/${orgB._id}`).set(bearer(orgA)).send({ isActive: false })).status);
    expect([403, 404]).toContain((await request.patch(`/api/users/${admin._id}`).set(bearer(orgA)).send({ isActive: false })).status);
    expect(await active(orgB)).toBe(true); expect(await active(admin)).toBe(true);
  });
  it('a staff member cannot change anyone\'s state', async () => {
    const s = await mkStaff('Staff Six', orgA); const t = await mkStaff('Staff Seven', orgA);
    expect((await request.patch(`/api/users/${t._id}`).set(bearer(s)).send({ isActive: false })).status).toBe(403);
    expect(await active(t)).toBe(true);
  });
  it('Remove (DELETE) keeps its meaning: deactivates, never erases', async () => {
    const s = await mkStaff('Staff Eight', orgA);
    expect((await request.delete(`/api/users/${s._id}`).set(bearer(orgA))).status).toBe(200);
    expect(await active(s)).toBe(false);
    expect(await User.exists({ _id: s._id })).toBeTruthy();
  });
  it('the other editable fields still work for an organizer, with no change to isActive when it is not sent', async () => {
    const s = await mkStaff('Staff Nine', orgA);
    const res = await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ fullName: 'Staff Nine Renamed' });
    expect(res.status).toBe(200);
    expect((await User.findById(s._id))?.fullName).toBe('Staff Nine Renamed');
    expect(await active(s)).toBe(true);
  });
});
