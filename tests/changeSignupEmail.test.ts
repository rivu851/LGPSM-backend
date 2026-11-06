/**
 * What a person does on the organizer sign-up: fills in step 1, lands on the 6-digit code page, notices the email is wrong and
 * taps "change email address". The code must then reach the new address, and only the new address must end up with an account.
 * Email delivery is mocked: no real mail is sent, and the code is read from the mocked mail body.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User } from '../src/models/User';
import { EmailVerification } from '../src/models/EmailVerification';

let mongoServer: MongoMemoryServer;
const mockSendEmail = jest.fn().mockResolvedValue(true);
jest.mock('../src/utils/email.provider', () => ({ sendEmail: (...a: any[]) => mockSendEmail(...a) }));

const lastMail = () => mockSendEmail.mock.calls[mockSendEmail.mock.calls.length - 1];
const lastOtp = () => (lastMail()[2] as string).match(/>\s*(\d{6})\s*<\/span>/)![1];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.JWT_SECRET = 'test_secret';
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret';
  process.env.ATLAS_URL = mongoServer.getUri();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => { await mongoose.disconnect(); await mongoServer.stop(); });
beforeEach(async () => { mockSendEmail.mockClear(); mockSendEmail.mockResolvedValue(true); await User.deleteMany({}); await EmailVerification.deleteMany({}); });

const signup = (over: object = {}) => request(app).post('/api/auth/register').send({ fullName: 'Rina Das', email: 'rina.typo@example.com', password: 'StrongPass123!', phone: '9876543210', role: 'ORGANIZER', ...over });
const verify = (email: string, code: string) => request(app).post('/api/auth/verify-email').send({ email, code });
const change = (body: object) => request(app).post('/api/auth/change-pending-email').send(body);

describe('"change email address" on the sign-up code page', () => {
  it('sends the new code to the corrected address, and only that address can finish the sign-up', async () => {
    expect((await signup()).status).toBe(201);
    const oldCode = lastOtp();
    const res = await change({ email: 'rina.typo@example.com', newEmail: 'rina@example.com', password: 'StrongPass123!' });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('rina@example.com');
    expect(lastMail()[0]).toBe('rina@example.com');
    const newCode = lastOtp();

    // the typo address no longer has an account or a code; the first code is dead
    expect(await User.findOne({ email: 'rina.typo@example.com' })).toBeNull();
    expect(await EmailVerification.findOne({ email: 'rina.typo@example.com' })).toBeNull();
    expect((await verify('rina.typo@example.com', oldCode)).status).toBe(400);

    // the corrected address verifies with its own code, and the account keeps the name and phone given in step 1
    expect((await verify('rina@example.com', newCode)).status).toBe(200);
    const user: any = await User.findOne({ email: 'rina@example.com' });
    expect(user.isEmailVerified).toBe(true);
    expect(user.fullName).toBe('Rina Das');
    expect(user.phone).toBe('919876543210');
    expect(await User.countDocuments({})).toBe(1);
  });

  it('is available straight away: the 60-second wait for "Resend code" does not apply to a new address', async () => {
    await signup();
    expect((await change({ email: 'rina.typo@example.com', newEmail: 'one@example.com', password: 'StrongPass123!' })).status).toBe(200);
    expect((await change({ email: 'one@example.com', newEmail: 'two@example.com', password: 'StrongPass123!' })).status).toBe(200);
    expect(await User.countDocuments({})).toBe(1);
    expect(await User.findOne({ email: 'two@example.com' })).not.toBeNull();
  });

  it('needs the password chosen in step 1, so a stranger cannot redirect someone else\'s pending sign-up', async () => {
    await signup();
    const res = await change({ email: 'rina.typo@example.com', newEmail: 'thief@example.com', password: 'WrongPass123!' });
    expect(res.status).toBe(401);
    expect(await User.findOne({ email: 'rina.typo@example.com' })).not.toBeNull();
    expect(await User.findOne({ email: 'thief@example.com' })).toBeNull();
  });

  it('refuses an address that already has an account, and leaves the pending sign-up as it was', async () => {
    await User.create({ fullName: 'Taken', email: 'taken@example.com', passwordHash: 'x', role: 'ORGANIZER', isActive: true, isEmailVerified: true });
    await signup();
    const res = await change({ email: 'rina.typo@example.com', newEmail: 'Taken@Example.com', password: 'StrongPass123!' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already/i);
    expect(await User.findOne({ email: 'rina.typo@example.com' })).not.toBeNull();
  });

  it('keeps the pending sign-up if the new code cannot be sent, so the person can try again', async () => {
    await signup();
    mockSendEmail.mockRejectedValueOnce(new Error('smtp down'));
    const res = await change({ email: 'rina.typo@example.com', newEmail: 'rina@example.com', password: 'StrongPass123!' });
    expect(res.status).toBe(503);
    expect(await User.findOne({ email: 'rina.typo@example.com' })).not.toBeNull();
    expect(await User.findOne({ email: 'rina@example.com' })).toBeNull();
    expect(await EmailVerification.findOne({ email: 'rina.typo@example.com' })).not.toBeNull();
  });

  it('does nothing for an account that is already verified, and says the same thing as for an unknown one', async () => {
    await User.create({ fullName: 'Done', email: 'done@example.com', passwordHash: 'x', role: 'ORGANIZER', isActive: true, isEmailVerified: true });
    const verified = await change({ email: 'done@example.com', newEmail: 'else@example.com', password: 'StrongPass123!' });
    const unknown = await change({ email: 'nobody@example.com', newEmail: 'else@example.com', password: 'StrongPass123!' });
    expect(verified.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(verified.body.message).toBe(unknown.body.message);
    expect(await User.findOne({ email: 'else@example.com' })).toBeNull();
  });

  it('rejects a malformed new address', async () => {
    await signup();
    expect((await change({ email: 'rina.typo@example.com', newEmail: 'not-an-email', password: 'StrongPass123!' })).status).toBe(400);
  });
});
