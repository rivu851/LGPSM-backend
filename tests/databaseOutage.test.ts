import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcrypt';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { CheckIn } from '../src/models/CheckIn';
import { generateAccessToken, generateRefreshToken } from '../src/utils/token';
import { hashToken } from '../src/utils/invitation.util';
import { admissionPayloadFor } from '../src/utils/qrPayload';

// A real outage: the database process is stopped while the app keeps running, then started again on the same port and files.
jest.setTimeout(120_000);

describe('database outage during an event', () => {
  let mongo: MongoMemoryServer;
  const PASS = 'a'.repeat(64);
  const LINK = 'b'.repeat(64);
  let eventId = '', guestId = '', token = '', refreshToken = '';

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 1500 });
    await Promise.all([CheckIn, Invitee].map((m: any) => m.syncIndexes()));
    const org = await User.create({ fullName: 'Org', email: 'org@outage.test', role: Role.ORGANIZER, isActive: true, isEmailVerified: true, passwordHash: await bcrypt.hash('RightPass123!', 4) });
    const ev = await Event.create({ organizerId: org._id, title: 'Outage Gala', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { address: 'Hall' }, schedule: { start: new Date(Date.now() - 3600e3), end: new Date(Date.now() + 3600e3) }, status: 'PUBLISHED' });
    const g = await Invitee.create({ eventId: ev._id, name: 'Guest', email: 'g@outage.test', qrTokenHash: hashToken(PASS), invitationTokenHash: hashToken(LINK), invitationStatus: 'SENT', rsvpStatus: 'ACCEPTED' });
    eventId = String(ev._id); guestId = String(g._id);
    token = generateAccessToken(String(org._id), Role.ORGANIZER);
    refreshToken = generateRefreshToken(String(org._id), Role.ORGANIZER);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await mongo.stop({ doCleanup: false });
    await new Promise((r) => setTimeout(r, 500));
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('sign-in, a door scan, a token refresh and a guest page all answer 503 quickly, and nothing hangs', async () => {
    const started = Date.now();
    const answers = await Promise.all([
      request(app).post('/api/auth/login').send({ email: 'org@outage.test', password: 'RightPass123!' }),
      request(app).post('/api/v1/checkins/scan').set({ Authorization: `Bearer ${token}` }).send({ qrCode: admissionPayloadFor(PASS), eventId }),
      request(app).post('/api/auth/refresh').send({ refreshToken }),
      request(app).get(`/api/v1/public/invitations/${LINK}`),
    ]);
    for (const a of answers) {
      expect(a.status).toBe(503);
      expect(a.body.code).toBe('SERVICE_UNAVAILABLE');
    }
    expect(Date.now() - started).toBeLessThan(30_000);
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.database).toBe('disconnected');
  });

  it('after the database returns, the same scan succeeds exactly once', async () => {
    await mongo.start(true);
    await mongoose.connection.asPromise();
    for (let i = 0; i < 40 && mongoose.connection.readyState !== 1; i++) await new Promise((r) => setTimeout(r, 500));
    expect(mongoose.connection.readyState).toBe(1);
    const first = await request(app).post('/api/v1/checkins/scan').set({ Authorization: `Bearer ${token}` }).send({ qrCode: admissionPayloadFor(PASS), eventId });
    expect(first.status).toBe(201);
    const repeat = await request(app).post('/api/v1/checkins/scan').set({ Authorization: `Bearer ${token}` }).send({ qrCode: admissionPayloadFor(PASS), eventId });
    expect(repeat.status).toBe(409);
    expect(await CheckIn.countDocuments({ inviteeId: guestId })).toBe(1);
  });
});
