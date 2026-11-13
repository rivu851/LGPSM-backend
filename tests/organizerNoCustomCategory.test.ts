import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });

describe('organizers cannot add their own categories or subcategories', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => { delete process.env.ALLOW_ORGANIZER_CUSTOM_CATEGORIES; mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('refuses both creations with a clear message', async () => {
    const org = await User.create({ fullName: 'O', email: 'o@x.com', role: Role.ORGANIZER, isActive: true });
    const a = await request(app).post('/api/v1/categories/custom').set(auth(org)).send({ name: 'Mine' });
    expect([a.status, a.body.message]).toEqual([403, 'Categories and subcategories are added by the administrator.']);
    const b = await request(app).post(`/api/v1/categories/${new mongoose.Types.ObjectId()}/custom-subcategories`).set(auth(org)).send({ name: 'Mine' });
    expect(b.status).toBe(403);
  });
});
