/**
 * Sign-in portals: the Organizer tab must never open an Admin account (and the reverse), by password.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

let mongoServer: MongoMemoryServer;
const login = (body: object) => request(app).post('/api/auth/login').send(body);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.JWT_SECRET = 'test_secret';
  await mongoose.connect(mongoServer.getUri());
  const bcrypt = require('bcrypt');
  const passwordHash = await bcrypt.hash('PortalPass123!', 10);
  await User.create({ fullName: 'Portal Admin', email: 'admin@portal.test', passwordHash, role: Role.ADMIN, isActive: true, isEmailVerified: true });
  await User.create({ fullName: 'Portal Organizer', email: 'org@portal.test', passwordHash, role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('password sign-in portals', () => {
  it('refuses an admin account on the Organizer tab, and an organizer on the Admin tab', async () => {
    const a = await login({ email: 'admin@portal.test', password: 'PortalPass123!', role: 'ORGANIZER' });
    const o = await login({ email: 'org@portal.test', password: 'PortalPass123!', role: 'ADMIN' });
    expect(a.status).toBe(403);
    expect(o.status).toBe(403);
    expect(a.body.data?.accessToken).toBeUndefined();
    expect(o.body.data?.accessToken).toBeUndefined();
  });

  it('signs each account in through its own tab, as its own role', async () => {
    const a = await login({ email: 'admin@portal.test', password: 'PortalPass123!', role: 'ADMIN' });
    const o = await login({ email: 'org@portal.test', password: 'PortalPass123!', role: 'ORGANIZER' });
    expect(a.body.data.user.role).toBe('ADMIN');
    expect(o.body.data.user.role).toBe('ORGANIZER');
  });
});
