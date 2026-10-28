/**
 * Sign-in portals: the Organizer tab must never open an Admin account (and the reverse), by password or Google.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { OAuth2Client } from 'google-auth-library';
import app from '../src/app';
import { env } from '../src/config/env';
import { User, Role, AuthProvider } from '../src/models/User';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

let mongoServer: MongoMemoryServer;
const login = (body: object) => request(app).post('/api/auth/login').send(body);
const google = (body: object) => request(app).post('/api/auth/google').send({ token: 'google-id-token', ...body });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.JWT_SECRET = 'test_secret';
  await mongoose.connect(mongoServer.getUri());
  const bcrypt = require('bcrypt');
  const passwordHash = await bcrypt.hash('PortalPass123!', 10);
  await User.create({ fullName: 'Portal Admin', email: 'admin@portal.test', passwordHash, role: Role.ADMIN, isActive: true, isEmailVerified: true });
  await User.create({ fullName: 'Portal Organizer', email: 'org@portal.test', passwordHash, role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  await User.create({ fullName: 'Google Admin', email: 'gadmin@portal.test', authProvider: AuthProvider.GOOGLE, role: Role.ADMIN, isActive: true, isEmailVerified: true });
  await User.create({ fullName: 'Google Organizer', email: 'gorg@portal.test', authProvider: AuthProvider.GOOGLE, role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
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

describe('Google sign-in portals', () => {
  const asGoogleUser = (email: string) => {
    (env as any).GOOGLE_CLIENT_ID = 'test-client-id';
    (jest.spyOn(OAuth2Client.prototype as any, 'verifyIdToken') as jest.SpyInstance).mockResolvedValue({ getPayload: () => ({ email, email_verified: true, name: 'G User' }) } as any);
  };
  afterEach(() => jest.restoreAllMocks());

  it('does not let the Organizer tab open a Google admin account', async () => {
    asGoogleUser('gadmin@portal.test');
    const res = await google({ role: 'ORGANIZER' });
    expect(res.status).toBe(403);
    expect(res.body.data?.accessToken).toBeUndefined();
  });

  it('does not let the Admin tab open a Google organizer account or create a new one', async () => {
    asGoogleUser('gorg@portal.test');
    expect((await google({ role: 'ADMIN' })).status).toBe(403);
    asGoogleUser('brand-new@portal.test');
    expect((await google({ role: 'ADMIN' })).status).toBe(403);
    expect(await User.exists({ email: 'brand-new@portal.test' })).toBeNull();
  });

  it('still signs an organizer in, and creates a new one, from the Organizer tab', async () => {
    asGoogleUser('gorg@portal.test');
    expect((await google({ role: 'ORGANIZER' })).body.data.user.role).toBe('ORGANIZER');
    asGoogleUser('created@portal.test');
    const created = await google({ role: 'ORGANIZER' });
    expect(created.status).toBe(200);
    expect(created.body.data.user.role).toBe('ORGANIZER');
  });
});
