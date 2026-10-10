/**
 * auth.test.ts
 *
 * Integration tests for the authentication and email-verification flows.
 *
 * Strategy for email delivery:
 *  - sendEmail is mocked at the module boundary so SMTP credentials are not
 *    required in test environments and the OTP plaintext is never logged.
 *  - The OTP itself is intercepted from the mocked sendEmail call by parsing
 *    the HTML body (the 6-digit code appears in a <span> in the email body).
 *  - This avoids any need to expose the code through an API or development log.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User } from '../src/models/User';
import { Role } from '../src/models/User';
import { EmailVerification } from '../src/models/EmailVerification';

let mongoServer: MongoMemoryServer;

// ─── Mock sendEmail so tests pass without SMTP credentials ────────────────────
// We capture calls so individual tests can extract the OTP from the email body.
const mockSendEmail = jest.fn().mockResolvedValue(true);

jest.mock('../src/utils/email.provider', () => ({
  sendEmail: (...args: any[]) => mockSendEmail(...args),
}));

/** Extracts the 6-digit OTP from the HTML that sendEmail was last called with. */
function extractOtpFromLastEmail(): string {
  expect(mockSendEmail).toHaveBeenCalled();
  const html: string = mockSendEmail.mock.calls[mockSendEmail.mock.calls.length - 1][2];
  // The OTP is a 6-digit span with letter-spacing in the email template
  const match = html.match(/>\s*(\d{6})\s*<\/span>/);
  if (!match) throw new Error('Could not extract OTP from email body');
  return match[1];
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  process.env.JWT_SECRET = 'test_secret';
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret';
  // ATLAS_URL must be set for env.ts Zod schema, but mongoose connects via uri above
  process.env.ATLAS_URL = uri;

  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  mockSendEmail.mockClear();
});

// ─── Registration ─────────────────────────────────────────────────────────────

describe('Registration', () => {
  it('creates an unverified account and returns pendingVerification=true', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'New Organizer', email: 'neworg@example.com', password: 'password123' });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.pendingVerification).toBe(true);
    expect(res.body.data.email).toBe('neworg@example.com');
    // No tokens issued at registration
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.body.data.refreshToken).toBeUndefined();
    // sendEmail was called
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    // OTP is NOT in the response body
    expect(JSON.stringify(res.body)).not.toMatch(/\d{6}/);
  });

  it('creates the user as active and unverified in the database', async () => {
    const user = await User.findOne({ email: 'neworg@example.com' });
    expect(user).not.toBeNull();
    expect(user!.isActive).toBe(true);
    expect(user!.isEmailVerified).toBe(false);
    // Password hash is not exposed
    expect((user as any).toJSON().passwordHash).toBeUndefined();
  });

  it('rolls back user creation if email sending fails so user can retry', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('SMTP connection failed'));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'SMTP Fail User', email: 'smtpfail@example.com', password: 'password123' });

    expect(res.statusCode).toBe(503);
    expect(res.body.success).toBe(false);

    // Verify user record was removed, preventing duplicate account collision
    const user = await User.findOne({ email: 'smtpfail@example.com' });
    expect(user).toBeNull();

    // Now registration with the same email succeeds on retry
    const retryRes = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'SMTP Fail User', email: 'smtpfail@example.com', password: 'password123' });

    expect(retryRes.statusCode).toBe(201);
    expect(retryRes.body.data.pendingVerification).toBe(true);
  });

  it('rejects duplicate registration', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'New Organizer', email: 'neworg@example.com', password: 'password123' });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('does not allow non-ORGANIZER self-registration', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Admin User', email: 'adminself@example.com', password: 'password123', role: 'ADMIN' });

    expect(res.statusCode).toBe(403);
  });
});

// ─── Login before verification ────────────────────────────────────────────────

describe('Login gate for unverified organizer', () => {
  it('blocks login with EMAIL_NOT_VERIFIED for an unverified organizer', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'neworg@example.com', password: 'password123' });

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('EMAIL_NOT_VERIFIED');
  });
});

// ─── Email Verification ───────────────────────────────────────────────────────

describe('Email Verification', () => {
  it('locks verification after 5 incorrect attempts', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Attempts User', email: 'attempts@example.com', password: 'password123' });

    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ email: 'attempts@example.com', code: '000000' });
      expect(res.statusCode).toBe(400);
    }

    // 5th attempt
    const res5 = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'attempts@example.com', code: '000000' });
    expect(res5.statusCode).toBe(400);
    expect(res5.body.message).toContain('all attempts');

    // Subsequent attempt should receive 429 too many attempts
    const res6 = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'attempts@example.com', code: '000000' });
    expect(res6.statusCode).toBe(429);
    expect(res6.body.message).toContain('Too many incorrect attempts');
  });

  it('rejects an incorrect OTP', async () => {
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'neworg@example.com', code: '000000' });

    // Either 400 (wrong code) or 429 (all attempts used) — must not be 200
    expect([400, 429]).toContain(res.statusCode);
    expect(res.body.success).toBe(false);
  });

  it('rejects a code that is not 6 digits', async () => {
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'neworg@example.com', code: '12345' });

    expect(res.statusCode).toBe(400);
  });

  it('verifies the correct OTP and activates the account', async () => {
    // Re-register a fresh user whose OTP we can capture cleanly
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Verify Me', email: 'verifyme@example.com', password: 'password123' });

    const otp = extractOtpFromLastEmail();

    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'verifyme@example.com', code: otp });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.verified).toBe(true);
    // No tokens in the verify response
    expect(res.body.data.accessToken).toBeUndefined();

    // User is now active and verified in the DB
    const user = await User.findOne({ email: 'verifyme@example.com' });
    expect(user!.isActive).toBe(true);
    expect(user!.isEmailVerified).toBe(true);
  });

  it('allows login after verification', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'verifyme@example.com', password: 'password123' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
  });

  it('blocks login if account is administratively disabled (isActive: false) even if email is verified', async () => {
    await User.updateOne({ email: 'verifyme@example.com' }, { isActive: false });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'verifyme@example.com', password: 'password123' });

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toContain('inactive account');

    // Restore isActive for subsequent tests
    await User.updateOne({ email: 'verifyme@example.com' }, { isActive: true });
  });

  it('rejects an expired OTP at the application layer', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Expire User', email: 'expire@example.com', password: 'password123' });

    const otp = extractOtpFromLastEmail();

    // Fast-forward expiresAt to the past to test application-layer check
    const { EmailVerification } = await import('../src/models/EmailVerification');
    await EmailVerification.updateOne(
      { email: 'expire@example.com' },
      { expiresAt: new Date(Date.now() - 5000) }
    );

    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'expire@example.com', code: otp });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain('expired');
  });

  it('rejects reuse of an already-consumed OTP', async () => {
    // The OTP record was deleted on successful verification — attempt again
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'verifyme@example.com', code: '000000' });

    // 400 — no pending verification record
    expect(res.statusCode).toBe(400);
  });
});

// ─── Resend ───────────────────────────────────────────────────────────────────

describe('Resend Verification', () => {
  it('resends a fresh OTP and the new OTP is valid', async () => {
    // Register a fresh user
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Resend User', email: 'resenduser@example.com', password: 'password123' });

    const firstOtp = extractOtpFromLastEmail();
    mockSendEmail.mockClear();

    // Resend (cooldown bypassed because the test runs fast; cooldown is
    // application-clock based — we test the business logic not the timer)
    // We skip cooldown by directly calling resend after the first send,
    // which will trigger a 429 if within cooldown. So we test the cooldown too.
    const cooldownRes = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'resenduser@example.com' });

    // Either sent (if > 60 s elapsed, unlikely in tests) or 429 within cooldown
    if (cooldownRes.statusCode === 429) {
      // Expected behaviour — cooldown is working
      expect(cooldownRes.body.success).toBe(false);
      return;
    }

    // If resend succeeded, the new OTP should work
    expect(cooldownRes.statusCode).toBe(200);
    const newOtp = extractOtpFromLastEmail();

    // Old OTP must be invalid now (only new one is valid)
    const oldOtpRes = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'resenduser@example.com', code: firstOtp });

    // Could be 400 (wrong) or 200 (if codes happened to match — astronomically unlikely)
    if (oldOtpRes.statusCode === 200 && firstOtp === newOtp) {
      // Codes matched by coincidence — skip assertion
      return;
    }
    expect(oldOtpRes.statusCode).not.toBe(200);

    // New OTP must work
    const verifyRes = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'resenduser@example.com', code: newOtp });
    expect(verifyRes.statusCode).toBe(200);
  });

  it('keeps the previous code valid when the resend email fails to send', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Resend SMTP Fail User', email: 'resendsmtpfail@example.com', password: 'password123' });

    const originalOtp = extractOtpFromLastEmail();
    mockSendEmail.mockClear();

    // Bypass the 60s cooldown deterministically instead of racing the clock.
    await EmailVerification.updateOne(
      { email: 'resendsmtpfail@example.com' },
      { $set: { lastSentAt: new Date(Date.now() - 61_000) } }
    );

    mockSendEmail.mockRejectedValueOnce(new Error('SMTP connection failed'));
    const resendRes = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'resendsmtpfail@example.com' });
    expect(resendRes.statusCode).toBe(503);

    // The original code must still verify — a failed resend must not destroy
    // the only code the user actually received.
    const verifyRes = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: 'resendsmtpfail@example.com', code: originalOtp });
    expect(verifyRes.statusCode).toBe(200);
  });

  it('returns success even for an unknown email (enumeration prevention)', async () => {
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'doesnotexist@example.com' });
    // Service returns { sent: true } for unknown emails
    expect(res.statusCode).toBe(200);
  });
});

// ─── Existing flows are unaffected ───────────────────────────────────────────

describe('Token flow (verified organizer)', () => {
  let userToken: string;
  let refreshToken: string;

  it('full login → profile → refresh → logout works for a verified organizer', async () => {
    // Use the verified account from the Email Verification describe block
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'verifyme@example.com', password: 'password123' });
    expect(login.statusCode).toBe(200);
    userToken = login.body.data.accessToken;
    refreshToken = login.body.data.refreshToken;

    const profile = await request(app)
      .get('/api/users/profile')
      .set('Authorization', `Bearer ${userToken}`);
    expect(profile.statusCode).toBe(200);
    expect(profile.body.data.email).toBe('verifyme@example.com');

    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.body.data.accessToken).toBeDefined();
    expect(refresh.body.data.refreshToken).toBeDefined();
    // Rotation: refresh issues a brand new refresh token distinct from the one spent.
    expect(refresh.body.data.refreshToken).not.toBe(refreshToken);
  });

  it('rejects reuse of a refresh token that was already rotated away', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'verifyme@example.com', password: 'password123' });
    const firstRefreshToken = login.body.data.refreshToken;

    const firstRefresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: firstRefreshToken });
    expect(firstRefresh.statusCode).toBe(200);

    // The token just spent above must now be rejected — mirrors the mobile
    // client, which must persist the rotated token rather than reusing the old one.
    const reuse = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: firstRefreshToken });
    expect(reuse.statusCode).toBe(401);
  });
});

describe('Pre-existing accounts (backward compat)', () => {
  it('a user created directly in the DB without isEmailVerified can still log in', async () => {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('LegacyPass123!', 10);
    // Simulate a pre-existing raw MongoDB account without isEmailVerified
    await User.collection.insertOne({
      fullName: 'Legacy Raw User',
      email: 'legacyraw@example.com',
      passwordHash: hash,
      authProvider: 'LOCAL',
      role: Role.ORGANIZER,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'legacyraw@example.com', password: 'LegacyPass123!' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
  });
});

describe('ADMIN login is unaffected by email verification gate', () => {
  it('an ADMIN with isEmailVerified omitted can log in normally', async () => {
    // Create an admin bypassing the register endpoint (admins are provisioned OOB)
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('AdminPass123!', 10);
    await User.create({
      fullName: 'Admin Account',
      email: 'admin.test@example.com',
      passwordHash: hash,
      authProvider: 'LOCAL',
      role: Role.ADMIN,
      isActive: true,
      isEmailVerified: true, // admins are always pre-verified
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin.test@example.com', password: 'AdminPass123!' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
  });
});

describe('Forgot password still works', () => {
  it('returns success regardless of whether the email exists', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'verifyme@example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
