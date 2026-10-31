import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { generateAccessToken } from '../src/utils/token';

const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });

describe('an admin adding and listing staff for one organizer', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(() => User.deleteMany({}));
  const mk = (name: string, role: Role) => User.create({ fullName: name, email: `${name}@x.com`, role, isActive: true });
  const add = (actor: any, body: object) => request(app).post('/api/users/').set(auth(actor)).send({ password: 'Str0ng!Passw0rd', role: 'SYSTEM_USER', ...body });

  it('staff added for an organizer belong to that organizer, and the list can be narrowed to one organizer', async () => {
    const admin = await mk('admin', Role.ADMIN); const a = await mk('orga', Role.ORGANIZER); const b = await mk('orgb', Role.ORGANIZER);
    expect((await add(admin, { fullName: 'Staff A', email: 'sa@x.com', organizerId: String(a._id) })).status).toBeLessThan(300);
    expect((await add(admin, { fullName: 'Staff B', email: 'sb@x.com', organizerId: String(b._id) })).status).toBeLessThan(300);
    expect((await add(admin, { fullName: 'Staff Admin', email: 'sx@x.com' })).status).toBeLessThan(300);
    const names = async (q: string) => (await request(app).get(`/api/users?role=SYSTEM_USER${q}`).set(auth(admin))).body.data.map((u: any) => u.fullName).sort();
    expect(await names('')).toEqual(['Staff A', 'Staff Admin', 'Staff B']);
    expect(await names(`&organizerId=${a._id}`)).toEqual(['Staff A']);
    expect(await names(`&organizerId=${b._id}`)).toEqual(['Staff B']);
    // the organizer sees the same staff on their own
    expect((await request(app).get('/api/users?role=SYSTEM_USER').set(auth(a))).body.data.map((u: any) => u.fullName)).toEqual(['Staff A']);
  });

  it('only an admin can add staff on behalf of an organizer, and only for a real organizer', async () => {
    const admin = await mk('admin', Role.ADMIN); const a = await mk('orga', Role.ORGANIZER); const b = await mk('orgb', Role.ORGANIZER);
    expect((await add(a, { fullName: 'Sneak', email: 's@x.com', organizerId: String(b._id) })).status).toBe(403);
    expect((await add(admin, { fullName: 'Ghost', email: 'g@x.com', organizerId: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
    expect((await add(admin, { fullName: 'Wrong', email: 'w@x.com', organizerId: String(admin._id) })).status).toBe(404);
  });
});
