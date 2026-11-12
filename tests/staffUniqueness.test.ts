import mongoose from 'mongoose';
import supertest from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { generateAccessToken } from '../src/utils/token';

// Audit finding F-02: simultaneous requests could add the same person to one organizer's staff several times.
const request = supertest(app);
jest.setTimeout(120_000);

describe('one listing of a person per organizer, even under simultaneous requests', () => {
  let mongo: MongoMemoryServer; let admin: any, orgA: any, orgB: any;
  const bearer = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
  const staffBody = (email: string, i = 0, extra: any = {}) => ({ fullName: 'Race Staff', email, role: 'SYSTEM_USER', password: 'RaceStaff1234!', phone: `91960000${String(i).padStart(4, '0')}`, ...extra });
  const count = (email: string, owner: any) => User.countDocuments({ email: email.toLowerCase(), role: Role.SYSTEM_USER, createdBy: owner._id, isActive: true });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await User.syncIndexes();
    const mk = (n: string, role: Role) => User.create({ fullName: n, email: `${n.replace(/\W/g, '').toLowerCase()}@u.test`, role, passwordHash: 'x', isActive: true });
    admin = await mk('Admin One', Role.ADMIN); orgA = await mk('Org A', Role.ORGANIZER); orgB = await mk('Org B', Role.ORGANIZER);
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('the index exists with the partial filter that keeps other rules intact', async () => {
    const idx = (await User.collection.indexes()).find((i: any) => i.name === 'uniq_active_staff_per_owner') as any;
    expect(idx?.unique).toBe(true);
    expect(idx.partialFilterExpression).toEqual({ role: 'SYSTEM_USER', isActive: true, createdBy: { $type: 'objectId' } });
  });

  it('10 simultaneous creations by an organizer: exactly one account', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => request.post('/api/users').set(bearer(orgA)).send(staffBody('race.org@x.test', i))));
    expect(await count('race.org@x.test', orgA)).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 201).every((r) => [400, 409].includes(r.status))).toBe(true);
    expect(rs.filter((r) => r.status !== 201).every((r) => /already one of your system users/.test(r.body.message))).toBe(true);
  });

  it('10 simultaneous creations by an admin for one organizer: exactly one account', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => request.post('/api/users').set(bearer(admin)).send(staffBody('race.admin@x.test', 20 + i, { organizerId: String(orgA._id) }))));
    expect(await count('race.admin@x.test', orgA)).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('an admin and the organizer adding the same person at once: exactly one account, owned by that organizer', async () => {
    const reqs = [
      ...Array.from({ length: 5 }, (_, i) => request.post('/api/users').set(bearer(admin)).send(staffBody('mixed@x.test', 40 + i, { organizerId: String(orgA._id) }))),
      ...Array.from({ length: 5 }, (_, i) => request.post('/api/users').set(bearer(orgA)).send(staffBody('MIXED@x.test', 50 + i))),
    ];
    const rs = await Promise.all(reqs);
    expect(await count('mixed@x.test', orgA)).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('the same person may still be staff of a different organizer (shared contact details are allowed)', async () => {
    expect((await request.post('/api/users').set(bearer(orgA)).send(staffBody('shared@x.test', 60))).status).toBe(201);
    expect((await request.post('/api/users').set(bearer(orgB)).send(staffBody('shared@x.test', 60))).status).toBe(201);
    expect(await count('shared@x.test', orgA)).toBe(1);
    expect(await count('shared@x.test', orgB)).toBe(1);
  });

  it('a removed (inactive) staff account does not count as a duplicate for the database, and only an administrator can bring the person back', async () => {
    const first = await request.post('/api/users').set(bearer(orgA)).send(staffBody('again@x.test', 70));
    expect(first.status).toBe(201);
    expect((await request.delete(`/api/users/${first.body.data._id}`).set(bearer(orgA))).status).toBe(200);
    expect(await count('again@x.test', orgA)).toBe(0);
    // the organizer may not bring the person back, by re-adding them or otherwise
    const again = await request.post('/api/users').set(bearer(orgA)).send(staffBody('again@x.test', 70));
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('STAFF_DEACTIVATED_ADMIN_ONLY');
    expect(await count('again@x.test', orgA)).toBe(0);
    // an administrator can: the removed account is reused
    const back = await request.post('/api/users').set(bearer(admin)).send(staffBody('again@x.test', 70, { organizerId: String(orgA._id) }));
    expect(back.status).toBe(201);
    expect(String(back.body.data._id)).toBe(first.body.data._id);
    expect(await count('again@x.test', orgA)).toBe(1);
  });

  it('the sequential duplicate is still refused with the friendly message', async () => {
    expect((await request.post('/api/users').set(bearer(orgA)).send(staffBody('seq@x.test', 80))).status).toBe(201);
    const dup = await request.post('/api/users').set(bearer(orgA)).send(staffBody('seq@x.test', 81));
    expect(dup.status).toBe(400);
    expect(dup.body.message).toMatch(/already one of your system users/);
  });

  it('changing a staff member\'s e-mail onto an existing colleague is refused (also through the database)', async () => {
    const a = await request.post('/api/users').set(bearer(orgA)).send(staffBody('edit.a@x.test', 90));
    const b = await request.post('/api/users').set(bearer(orgA)).send(staffBody('edit.b@x.test', 91));
    const res = await request.patch(`/api/users/${b.body.data._id}`).set(bearer(admin)).send({ email: 'edit.a@x.test' });
    expect([400, 409]).toContain(res.status);
    expect((await User.findById(a.body.data._id))?.email).toBe('edit.a@x.test');
    expect((await User.findById(b.body.data._id))?.email).toBe('edit.b@x.test');
  });
});
