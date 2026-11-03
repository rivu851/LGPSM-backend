import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcrypt';
import { User, Role } from '../src/models/User';

// The real limiters, switched on. Own file: each jest file has its own module registry, so these counters do not touch other suites.
jest.setTimeout(60_000);
process.env.ENABLE_RATE_LIMIT_TESTS = 'true';

describe('rate limits', () => {
  let mongo: MongoMemoryServer;
  let app: any;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await User.create({ fullName: 'Door Staff', email: 'door@x.test', passwordHash: await bcrypt.hash('RightPass123!', 4), role: Role.SYSTEM_USER, isActive: true, isEmailVerified: true });
    app = (await import('../src/app')).default;
  });
  afterAll(async () => { delete process.env.ENABLE_RATE_LIMIT_TESTS; await mongoose.disconnect(); await mongo.stop(); });

  it('a venue full of devices refreshing tokens from one address is not throttled like password recovery', async () => {
    for (let i = 0; i < 40; i++) {
      const r = await request(app).post('/api/auth/refresh').send({ refreshToken: 'not-a-token' });
      expect(r.status).not.toBe(429);
    }
  });

  it('a team signing in from one address is not blocked, while guessing one account is', async () => {
    for (let i = 0; i < 25; i++) {
      const ok = await request(app).post('/api/auth/login').send({ email: 'door@x.test', password: 'RightPass123!' });
      expect(ok.status).toBe(200);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await request(app).post('/api/auth/login').send({ email: 'door@x.test', password: `wrong-${i}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[11]).toBe(429);
    // someone else on the same network is unaffected
    expect((await request(app).post('/api/auth/login').send({ email: 'other@x.test', password: 'whatever' })).status).toBe(401);
  });

  it('password recovery keeps its strict limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@x.test' })).status);
    expect(statuses[0]).toBe(200);
    expect(statuses[21]).toBe(429);
  });
});
