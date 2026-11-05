import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });

describe('custom (per-organizer) categories', () => {
  let mongo: MongoMemoryServer; let a: any; let b: any; let admin: any; let corporate: any;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Category.deleteMany({})]);
    a = await User.create({ fullName: 'A', email: 'a@x.com', role: Role.ORGANIZER, isActive: true });
    b = await User.create({ fullName: 'B', email: 'b@x.com', role: Role.ORGANIZER, isActive: true });
    admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', role: Role.ADMIN, isActive: true });
    corporate = await Category.create({ name: 'Corporate', isActive: true, subcategories: [{ name: 'Conference' }] });
  });
  const list = async (u?: any) => (await request(app).get('/api/v1/categories').set(u ? auth(u) : {})).body.data as any[];

  it('an organizer creates a category only they can see', async () => {
    const res = await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'Alumni Meet' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Alumni Meet', isCustom: true });
    expect((await list(a)).map((c) => c.name)).toEqual(['Alumni Meet', 'Corporate']);
    expect((await list(b)).map((c) => c.name)).toEqual(['Corporate']);
    expect((await list()).map((c) => c.name)).toEqual(['Corporate']);
    expect((await list(admin)).map((c) => c.name)).toEqual(['Corporate']);
    // and cannot be fetched by id by anyone else
    expect((await request(app).get(`/api/v1/categories/${res.body.data._id}`).set(auth(b))).status).toBe(404);
    expect((await request(app).get(`/api/v1/categories/${res.body.data._id}`).set(auth(a))).status).toBe(200);
  });

  it('refuses names that repeat what the organizer can already pick, but allows another organizer the same name', async () => {
    expect((await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: ' corporate ' })).status).toBe(409);
    expect((await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'Alumni' })).status).toBe(201);
    expect((await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'ALUMNI' })).status).toBe(409);
    expect((await request(app).post('/api/v1/categories/custom').set(auth(b)).send({ name: 'Alumni' })).status).toBe(201);
  });

  it('only organizers can create custom ones, and the name is limited', async () => {
    expect((await request(app).post('/api/v1/categories/custom').set(auth(admin)).send({ name: 'Nope' })).status).toBe(403);
    expect((await request(app).post('/api/v1/categories/custom')).status).toBe(401);
    expect((await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'x'.repeat(61) })).status).toBe(400);
  });

  it('a custom subcategory goes under the platform category and is visible only to its owner', async () => {
    const res = await request(app).post(`/api/v1/categories/${corporate._id}/custom-subcategories`).set(auth(a)).send({ name: 'Town Hall' });
    expect(res.status).toBe(201);
    const subs = (cs: any[]) => cs.find((c) => c.name === 'Corporate').subcategories.map((s: any) => s.name);
    expect(subs(await list(a))).toEqual(['Conference', 'Town Hall']);
    expect(subs(await list(b))).toEqual(['Conference']);
    expect((await request(app).post(`/api/v1/categories/${corporate._id}/custom-subcategories`).set(auth(a)).send({ name: 'conference' })).status).toBe(409);
  });

  it("an administrator's save of the category does not wipe organizers' custom subcategories", async () => {
    await request(app).post(`/api/v1/categories/${corporate._id}/custom-subcategories`).set(auth(a)).send({ name: 'Town Hall' });
    const visible = (await list(admin)).find((c) => c.name === 'Corporate');
    expect(visible.subcategories.map((s: any) => s.name)).toEqual(['Conference']);
    await request(app).patch(`/api/v1/categories/${corporate._id}`).set(auth(admin)).send({ subcategories: visible.subcategories.map((s: any) => ({ _id: s._id, name: s.name })) });
    expect(((await list(a)).find((c) => c.name === 'Corporate')).subcategories.map((s: any) => s.name)).toEqual(['Conference', 'Town Hall']);
  });

  it("an event cannot use another organizer's custom category", async () => {
    const mine = (await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'Alumni' })).body.data;
    const body = (categoryId: string) => ({ title: 'T', description: 'd', categoryId, format: 'PHYSICAL', location: { address: 'x' }, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) } });
    expect((await request(app).post('/api/v1/events').set(auth(b)).send(body(mine._id))).status).toBe(400);
  });
});
