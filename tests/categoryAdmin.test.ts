/**
 * Adding categories and subcategories from Template Settings and Add Event: what the admin creates must be stored,
 * come back in the list the dropdowns read, and be refused for non-admins and duplicates.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { generateAccessToken } from '../src/utils/token';

let mongoServer: MongoMemoryServer;
let adminToken: string, organizerToken: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const list = async () => (await request(app).get('/api/v1/categories?activeOnly=true')).body.data as any[];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.JWT_SECRET = 'test_secret';
  await mongoose.connect(mongoServer.getUri());
  const admin = await User.create({ fullName: 'Cat Admin', email: 'cat-admin@example.com', passwordHash: 'x', role: Role.ADMIN, isActive: true, isEmailVerified: true });
  const organizer = await User.create({ fullName: 'Cat Org', email: 'cat-org@example.com', passwordHash: 'x', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  adminToken = generateAccessToken(String(admin._id), Role.ADMIN);
  organizerToken = generateAccessToken(String(organizer._id), Role.ORGANIZER);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('categories added from the admin screens', () => {
  it('a new category is stored and appears in the list the dropdowns read', async () => {
    const res = await request(app).post('/api/v1/categories').set(bearer(adminToken)).send({ name: 'Festival' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Festival', isActive: true, subcategories: [] });
    expect((await list()).map((c) => c.name)).toContain('Festival');
  });

  it('a new subcategory is stored under its category and appears in the list, with its own id', async () => {
    const { body } = await request(app).post('/api/v1/categories').set(bearer(adminToken)).send({ name: 'Sports' });
    const added = await request(app).post(`/api/v1/categories/${body.data._id}/subcategories`).set(bearer(adminToken)).send({ name: 'Marathon' });
    expect(added.status).toBe(201);
    const sub = added.body.data.subcategories.find((s: any) => s.name === 'Marathon');
    expect(sub._id).toMatch(/^[0-9a-f]{24}$/);
    const sports = (await list()).find((c) => c.name === 'Sports');
    expect(sports.subcategories.map((s: any) => s.name)).toEqual(['Marathon']);
  });

  it('refuses duplicates (any letter case), too-short names, and non-admins', async () => {
    const dup = await request(app).post('/api/v1/categories').set(bearer(adminToken)).send({ name: 'festival' });
    expect(dup.status).toBe(409);
    expect((await request(app).post('/api/v1/categories').set(bearer(adminToken)).send({ name: 'A' })).status).toBe(400);
    expect((await request(app).post('/api/v1/categories').set(bearer(organizerToken)).send({ name: 'Nope Org' })).status).toBe(403);
    expect((await list()).map((c) => c.name)).not.toContain('Nope Org');
  });
});
