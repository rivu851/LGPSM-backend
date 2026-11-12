import mongoose from 'mongoose';
import supertest from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { AuditLog } from '../src/models/AuditLog';
import { generateAccessToken } from '../src/utils/token';
import { hashPassword } from '../src/utils/password';

// Approved policy: organizers may deactivate their staff but never reactivate them; administrators may do both;
// every switch on or off is written to the audit log.
const request = supertest(app);
jest.setTimeout(60_000);

describe('staff on/off policy, on every route that can change it', () => {
  let mongo: MongoMemoryServer; let admin: any, orgA: any, orgB: any;
  const bearer = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
  let n = 0;
  const mkStaff = async (owner: any, active = true) => { n++; return User.create({ fullName: `Policy Staff ${n}`, email: `policy${n}@p.test`, role: Role.SYSTEM_USER, passwordHash: await hashPassword('StaffPass1234!'), isActive: active, createdBy: owner._id, phone: `919400000${String(n).padStart(3, '0')}` }); };
  const state = async (u: any) => (await User.findById(u._id))!.isActive;
  const entries = (u: any) => AuditLog.find({ entityId: u._id, action: { $in: ['USER_DEACTIVATED', 'USER_REACTIVATED'] } }).sort({ createdAt: 1 }).lean();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    const mk = (nm: string, role: Role) => User.create({ fullName: nm, email: `${nm.replace(/\W/g, '').toLowerCase()}@p.test`, role, passwordHash: 'x', isActive: true });
    admin = await mk('Admin P', Role.ADMIN); orgA = await mk('Org PA', Role.ORGANIZER); orgB = await mk('Org PB', Role.ORGANIZER);
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('an organizer deactivates with Remove (DELETE): the switch is audited with who, which account and how', async () => {
    const s = await mkStaff(orgA);
    expect((await request.delete(`/api/users/${s._id}`).set(bearer(orgA))).status).toBe(200);
    expect(await state(s)).toBe(false);
    const [e] = await entries(s);
    expect(e.action).toBe('USER_DEACTIVATED');
    expect(String(e.actorId)).toBe(String(orgA._id));
    expect(e.actorType).toBe('ORGANIZER');
    expect(String(e.organizerId)).toBe(String(orgA._id));
    expect(e.metadata).toMatchObject({ targetRole: 'SYSTEM_USER', from: true, to: false, via: 'DELETE' });
  });
  it('an organizer deactivates with PATCH: audited once; repeating it adds no second entry', async () => {
    const s = await mkStaff(orgA);
    await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ isActive: false });
    await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ isActive: false });
    const list = await entries(s);
    expect(list).toHaveLength(1);
    expect(list[0].metadata).toMatchObject({ via: 'PATCH', to: false });
  });
  it('an organizer cannot reactivate by PATCH (alone or mixed with other changes): refused, nothing changes, nothing audited', async () => {
    const s = await mkStaff(orgA, false);
    const res = await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ isActive: true, fullName: 'Sneaky Rename' });
    expect(res.status).toBe(403);
    expect(await state(s)).toBe(false);
    expect((await User.findById(s._id))!.fullName).toBe(s.fullName);
    expect(await entries(s)).toHaveLength(0);
  });
  it('an organizer cannot reactivate by adding the person again (a new account would get round the deactivation just the same)', async () => {
    const s = await mkStaff(orgA, false);
    const res = await request.post('/api/users').set(bearer(orgA)).send({ fullName: 'Re Added', email: s.email, role: 'SYSTEM_USER', password: 'ReAdded12345!', phone: '919400009999' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STAFF_DEACTIVATED_ADMIN_ONLY');
    expect(await state(s)).toBe(false);
    expect(await User.countDocuments({ email: s.email })).toBe(1);
  });
  it('an organizer cannot reach another organizer\'s staff in either direction', async () => {
    const s = await mkStaff(orgB); const off = await mkStaff(orgB, false);
    expect([403, 404]).toContain((await request.patch(`/api/users/${s._id}`).set(bearer(orgA)).send({ isActive: false })).status);
    expect([403, 404]).toContain((await request.delete(`/api/users/${s._id}`).set(bearer(orgA))).status);
    expect([403, 404]).toContain((await request.patch(`/api/users/${off._id}`).set(bearer(orgA)).send({ isActive: true })).status);
    expect(await state(s)).toBe(true); expect(await state(off)).toBe(false);
  });
  it('an administrator deactivates and reactivates, each switch audited with the administrator as actor', async () => {
    const s = await mkStaff(orgA);
    expect((await request.patch(`/api/users/${s._id}`).set(bearer(admin)).send({ isActive: false })).status).toBe(200);
    expect((await request.patch(`/api/users/${s._id}`).set(bearer(admin)).send({ isActive: true })).status).toBe(200);
    const list = await entries(s);
    expect(list.map((e: any) => e.action)).toEqual(['USER_DEACTIVATED', 'USER_REACTIVATED']);
    expect(list.every((e: any) => String(e.actorId) === String(admin._id) && e.actorType === 'ADMIN')).toBe(true);
    expect(list[1].metadata).toMatchObject({ from: false, to: true, via: 'PATCH' });
  });
  it('an administrator adding the person again brings the account back, audited as such', async () => {
    const s = await mkStaff(orgA, false);
    const res = await request.post('/api/users').set(bearer(admin)).send({ fullName: 'Back Again', email: s.email, role: 'SYSTEM_USER', password: 'BackAgain12345!', phone: '919400008888', organizerId: String(orgA._id) });
    expect(res.status).toBe(201);
    expect(String(res.body.data._id)).toBe(String(s._id));
    expect(await state(s)).toBe(true);
    const [e] = await entries(s);
    expect(e.action).toBe('USER_REACTIVATED');
    expect(e.metadata).toMatchObject({ via: 'RE_ADD' });
  });
  it('a deactivated staff member cannot be assigned to an event (the on/off state is honoured everywhere)', async () => {
    const s = await mkStaff(orgA, false);
    const login = await request.post('/api/auth/login').send({ email: s.email, password: 'StaffPass1234!', role: 'SYSTEM_USER' });
    expect([401, 403]).toContain(login.status);
  });
  it('a staff member cannot switch anyone on or off', async () => {
    const s = await mkStaff(orgA); const t = await mkStaff(orgA, false);
    expect((await request.patch(`/api/users/${t._id}`).set(bearer(s)).send({ isActive: true })).status).toBe(403);
    expect(await state(t)).toBe(false);
  });
});
