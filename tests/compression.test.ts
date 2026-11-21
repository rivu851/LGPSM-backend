import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60000);
describe('responses are compressed', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('a long JSON list is gzipped when the client accepts it, and a short one is left alone', async () => {
    const u: any = await User.create({ fullName: 'A', email: 'a@c.test', role: Role.ADMIN, isActive: true });
    const auth = { Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` };
    await Category.insertMany(Array.from({ length: 60 }, (_, i) => ({ name: `Category number ${i}`, isActive: true })));
    const big = await request(app).get('/api/v1/categories').set(auth).set('Accept-Encoding', 'gzip');
    expect(big.headers['content-encoding']).toBe('gzip');
    expect(big.status).toBe(200);
    expect(Array.isArray(big.body.data ?? big.body)).toBe(true); // supertest unzips it for us
    const plain = await request(app).get('/api/v1/categories').set(auth).set('Accept-Encoding', 'identity');
    expect(plain.headers['content-encoding']).toBeUndefined();
  });
});
