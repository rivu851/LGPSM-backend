import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { EmailVerification } from '../src/models/EmailVerification';

// Google's token check is replaced: the tests decide what "Google" says about the credential
let google: any = {};
jest.mock('google-auth-library', () => ({
  OAuth2Client: class { async verifyIdToken() { if (google.fail) throw new Error('bad token'); return { getPayload: () => google.payload }; } },
}));

jest.setTimeout(60000);
const sign = (credential = 'x'.repeat(40)) => request(app).post('/api/auth/google').send({ credential });
const says = (p: object) => { google = { payload: { email: 'sam@gmail.com', email_verified: true, name: 'Sam Roy', sub: 'g-1', ...p } }; };

describe('Sign in with Google (organizers only)', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => { await Promise.all([User.deleteMany({}), EmailVerification.deleteMany({})]); process.env.GOOGLE_CLIENT_ID = 'client-1.apps.googleusercontent.com'; says({}); });

  it('says so when Google sign-in is not set up on the server', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const r = await sign();
    expect([r.status, r.body.code]).toEqual([503, 'GOOGLE_NOT_CONFIGURED']);
  });

  it('refuses a credential Google does not confirm, and an unverified Google address', async () => {
    google = { fail: true };
    expect((await sign()).status).toBe(401);
    says({ email_verified: false });
    expect((await sign()).status).toBe(401);
  });

  it('a new address becomes a verified organizer with tokens, flagged as new, and no password', async () => {
    const r = await sign();
    expect(r.status).toBe(200);
    expect(r.body.data.isNewUser).toBe(true);
    expect(r.body.data.accessToken).toBeTruthy();
    const u: any = await User.findOne({ email: 'sam@gmail.com' }).lean();
    expect(u).toMatchObject({ role: Role.ORGANIZER, fullName: 'Sam Roy', isEmailVerified: true, isActive: true, googleId: 'g-1', authProvider: 'GOOGLE' });
    expect(u.passwordHash).toBeUndefined();
    // password sign-in cannot be used on it
    const p = await request(app).post('/api/auth/login').send({ email: 'sam@gmail.com', password: 'whatever123', role: 'ORGANIZER' });
    expect(p.status).toBe(401);
  });

  it('an existing organizer on that address is signed in (and linked), not duplicated', async () => {
    await User.create({ fullName: 'Sam', email: 'sam@gmail.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true, passwordHash: 'x' });
    const first = await sign();
    expect([first.status, first.body.data.isNewUser]).toEqual([200, false]);
    expect(await User.countDocuments({ email: 'sam@gmail.com' })).toBe(1);
    expect((await User.findOne({ email: 'sam@gmail.com' }))!.googleId).toBe('g-1');
    // a different Google account cannot take over the same address
    says({ sub: 'g-2' });
    expect((await sign()).status).toBe(403);
  });

  it('Google confirming the address completes a sign-up that was waiting for its code', async () => {
    await User.create({ fullName: 'Sam', email: 'sam@gmail.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: false, passwordHash: 'x' });
    await EmailVerification.create({ email: 'sam@gmail.com', codeHash: 'h', expiresAt: new Date(Date.now() + 600000), attempts: 0, lastSentAt: new Date() });
    expect((await sign()).status).toBe(200);
    expect((await User.findOne({ email: 'sam@gmail.com' }))!.isEmailVerified).toBe(true);
    expect(await EmailVerification.countDocuments({ email: 'sam@gmail.com' })).toBe(0);
  });

  it('administrators and deactivated organizers are refused with a clear reason', async () => {
    await User.create({ fullName: 'Boss', email: 'sam@gmail.com', role: Role.ADMIN, isActive: true });
    let r = await sign();
    expect([r.status, r.body.code]).toEqual([403, 'GOOGLE_ORGANIZERS_ONLY']);
    await User.deleteMany({});
    await User.create({ fullName: 'Sam', email: 'sam@gmail.com', role: Role.ORGANIZER, isActive: false, isEmailVerified: true });
    r = await sign();
    expect([r.status, r.body.code]).toEqual([403, 'ACCOUNT_INACTIVE']);
  });
});
