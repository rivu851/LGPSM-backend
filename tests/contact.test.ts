import crypto from 'crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { ContactMessage } from '../src/models/ContactMessage';
import { Notification } from '../src/models/Notification';
import { PlatformSettings } from '../src/models/PlatformSettings';
import { User, Role } from '../src/models/User';
import { notificationPreferencesSchema } from '../src/validators/platformSettings.validator';
import { submitContactSchema } from '../src/validators/contact.validator';
import { sendEmail } from '../src/utils/email.provider';
import { DUPLICATE_WINDOW_MS } from '../src/services/contact.service';

// No real mail is ever sent from tests: the provider is replaced with a mock for the whole file
jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn() }));
const sendEmailMock = sendEmail as jest.Mock;

const URL = '/api/v1/public/contact';
const valid = () => ({
  name: 'Riya Sharma',
  email: 'riya@example.com',
  phone: '+91 98765-43210',
  message: 'Hello, I would like to know more about your event invitation plans.'
});

// The alert service sends mail in the background; wait for those promises to settle
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('Public contact form API', () => {
  let mongoServer: MongoMemoryServer;
  let admin: any;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await ContactMessage.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await ContactMessage.deleteMany({});
    await Notification.deleteMany({});
    await User.deleteMany({});
    await PlatformSettings.deleteMany({});
    admin = await User.create({ fullName: 'Admin', email: 'admin.contact@example.com', role: Role.ADMIN, isActive: true });
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue(true);
  });

  describe('validation and normalisation', () => {
    it.each([
      ['missing name', { ...valid(), name: undefined }, /name/i],
      ['single-character name', { ...valid(), name: 'R' }, /at least 2/i],
      ['missing email', { ...valid(), email: undefined }, /email/i],
      ['malformed email', { ...valid(), email: 'not-an-email' }, /valid email/i],
      ['missing message', { ...valid(), message: undefined }, /message/i],
      ['too-short message', { ...valid(), message: 'too short' }, /at least 10/i],
      ['too-long message', { ...valid(), message: 'x'.repeat(2001) }, /at most 2000/i],
      ['bad phone', { ...valid(), phone: '12ab' }, /valid phone/i],
      ['phone with too few digits', { ...valid(), phone: '12345' }, /valid phone/i],
      ['link-stuffed message', { ...valid(), message: 'Visit http://a.example http://b.example http://c.example now please' }, /remove links/i]
    ])('rejects %s with 400 and a field-level detail', async (_label, body, messageRe) => {
      const res = await request(app).post(URL).send(body);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.message).toMatch(messageRe);
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(res.body.details[0].path[0]).toBe('body');
      // The contract exposes only { path, message }: no validator internals such as regex patterns
      expect(Object.keys(res.body.details[0]).sort()).toEqual(['message', 'path']);
      expect(await ContactMessage.countDocuments()).toBe(0);
    });

    it('normalises input before it is stored', () => {
      const parsed = submitContactSchema.parse({
        body: {
          name: '  Riya   Sharma  ',
          email: '  RIYA@Example.COM ',
          phone: ' +91 (98765) 43210 ',
          message: '  Line one   \r\n\r\n\r\n\r\nLine\u0000 two  '
        }
      }).body;
      expect(parsed.name).toBe('Riya Sharma');
      expect(parsed.email).toBe('riya@example.com');
      expect(parsed.phone).toBe('+919876543210');
      expect(parsed.message).toBe('Line one\n\nLine two');
    });

    it('treats an empty phone as not provided', async () => {
      const res = await request(app).post(URL).send({ ...valid(), phone: '   ' });
      expect(res.status).toBe(201);
      const doc = await ContactMessage.findById(res.body.data.id);
      expect(doc!.phone).toBeUndefined();
    });
  });

  describe('successful submission', () => {
    it('persists the request and returns the documented contract', async () => {
      const res = await request(app).post(URL).set('User-Agent', 'jest-agent').send(valid());

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        success: true,
        message: expect.stringMatching(/received/i),
        data: { id: expect.any(String), status: 'NEW', receivedAt: expect.any(String), duplicate: false }
      });
      expect(new Date(res.body.data.receivedAt).toString()).not.toBe('Invalid Date');

      const doc = await ContactMessage.findById(res.body.data.id);
      expect(doc).not.toBeNull();
      expect(doc).toMatchObject({
        name: 'Riya Sharma',
        email: 'riya@example.com',
        phone: '+919876543210',
        status: 'NEW',
        userAgent: 'jest-agent'
      });
      expect(doc!.createdAt).toBeInstanceOf(Date);
    });

    it('stores a keyed hash of the client IP, never the raw address', async () => {
      const res = await request(app).post(URL).send(valid());
      const doc = (await ContactMessage.findById(res.body.data.id))!;
      expect(doc.ipHash).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(doc.toObject())).not.toMatch(/127\.0\.0\.1|::ffff|::1/);
    });

    it('ignores unknown / spoofed fields such as status', async () => {
      const res = await request(app).post(URL).send({ ...valid(), status: 'RESOLVED', _id: new mongoose.Types.ObjectId() });
      expect(res.status).toBe(201);
      expect((await ContactMessage.findById(res.body.data.id))!.status).toBe('NEW');
    });
  });

  describe('retry and duplicate handling', () => {
    it('treats an identical resubmission as a retry: same id, no second row, no second alert', async () => {
      const first = await request(app).post(URL).send(valid());
      await flush();
      const alertsAfterFirst = await Notification.countDocuments();

      const second = await request(app).post(URL).send({ ...valid(), message: `${valid().message.toUpperCase()}  ` });
      await flush();

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.data).toMatchObject({ id: first.body.data.id, duplicate: true, status: 'NEW' });
      expect(await ContactMessage.countDocuments()).toBe(1);
      expect(await Notification.countDocuments()).toBe(alertsAfterFirst);
    });

    it('collapses concurrent identical submissions (double click) into one stored message', async () => {
      const results = await Promise.all([1, 2, 3, 4].map(() => request(app).post(URL).send(valid())));
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(await ContactMessage.countDocuments()).toBe(1);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    });

    // Simulates a stored message from an *earlier* 10-minute bucket (so the unique bucket key cannot
    // match) with a given age, using the same fingerprint the service computes
    const seedEarlierMessage = async (ageMs: number) => {
      const v = valid();
      const message = v.message.toLowerCase().replace(/\s+/g, ' ').trim();
      const fingerprint = crypto.createHash('sha256').update(`${v.email}\n${message}`).digest('hex');
      const createdAt = new Date(Date.now() - ageMs);
      return ContactMessage.create({
        name: v.name, email: v.email, message: v.message, fingerprint,
        dedupeKey: `${fingerprint}:${Math.floor(Date.now() / DUPLICATE_WINDOW_MS) - 1}`,
        createdAt
      });
    };

    it('recognises a retry that straddles a time-bucket boundary (identical message stored 5 minutes ago)', async () => {
      const earlier = await seedEarlierMessage(5 * 60 * 1000);
      const res = await request(app).post(URL).send(valid());
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: String(earlier._id), duplicate: true });
      expect(await ContactMessage.countDocuments()).toBe(1);
    });

    it('accepts the same message again once the duplicate window has passed (stored 11 minutes ago)', async () => {
      await seedEarlierMessage(11 * 60 * 1000);
      const res = await request(app).post(URL).send(valid());
      expect(res.status).toBe(201);
      expect(res.body.data.duplicate).toBe(false);
      expect(await ContactMessage.countDocuments()).toBe(2);
    });

    it('stores a genuinely different message from the same visitor', async () => {
      await request(app).post(URL).send(valid());
      const other = await request(app).post(URL).send({ ...valid(), message: 'A completely different question about pricing tiers.' });
      expect(other.status).toBe(201);
      expect(await ContactMessage.countDocuments()).toBe(2);
    });
  });

  describe('spam mitigation', () => {
    it('silently drops honeypot submissions: success-shaped reply, nothing stored or sent', async () => {
      const res = await request(app).post(URL).send({ ...valid(), website: 'https://spam.example' });
      await flush();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeUndefined();
      expect(await ContactMessage.countDocuments()).toBe(0);
      expect(await Notification.countDocuments()).toBe(0);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  describe('admin notification', () => {
    it('alerts active admins in-app and by email', async () => {
      const res = await request(app).post(URL).send(valid());
      await flush();
      expect(res.status).toBe(201);
      const notes = await Notification.find({ userId: admin._id });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ type: 'CONTACT_MESSAGE', entityType: 'CONTACT_MESSAGE' });
      expect(String(notes[0].entityId)).toBe(res.body.data.id);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(sendEmailMock.mock.calls[0][0]).toBe('admin.contact@example.com');
    });

    it('keeps the stored request and still reports success when the notification email fails', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      sendEmailMock.mockRejectedValue(new Error('SMTP down'));

      const res = await request(app).post(URL).send(valid());
      await flush();

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(await ContactMessage.countDocuments()).toBe(1);
      expect(await Notification.countDocuments({ userId: admin._id })).toBe(1);
      // The failure is logged, not swallowed silently
      expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/Admin alert email failed: SMTP down/);
      errorSpy.mockRestore();
    });

    it('keeps the stored request when the whole alert pipeline throws', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { alertService } = await import('../src/services/alert.service');
      const spy = jest.spyOn(alertService, 'notifyAdmins').mockRejectedValueOnce(new Error('boom'));

      const res = await request(app).post(URL).send(valid());

      expect(res.status).toBe(201);
      expect(await ContactMessage.countDocuments()).toBe(1);
      expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/admin notification failed: boom/);
      spy.mockRestore();
      errorSpy.mockRestore();
    });

    it('respects the admin preference: no alert when newContactMessage is switched off', async () => {
      await PlatformSettings.create({ key: 'global', notificationPreferences: { newContactMessage: false } });
      const res = await request(app).post(URL).send(valid());
      await flush();
      expect(res.status).toBe(201);
      expect(await ContactMessage.countDocuments()).toBe(1);
      expect(await Notification.countDocuments()).toBe(0);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('still lets an older settings page (that does not send newContactMessage) save preferences', () => {
      const legacy = {
        newOrganizerRegistration: true, newEventAdded: true, deactivatedOrganizerBySuperAdmin: true,
        changeInPrice: true, invitationSendFailed: true, dayBeforeEventAlert: true, reportDownload: false, customTemplateRequest: true
      };
      expect(notificationPreferencesSchema.safeParse(legacy).success).toBe(true);
      expect(notificationPreferencesSchema.safeParse({ ...legacy, newContactMessage: false }).success).toBe(true);
    });
  });

  describe('server errors', () => {
    it('returns a generic 500 without leaking internals when persistence fails', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const spy = jest.spyOn(ContactMessage, 'create').mockRejectedValueOnce(new Error('E11000 secret internal detail') as never);

      const res = await request(app).post(URL).send(valid());

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/try again/i);
      expect(JSON.stringify(res.body)).not.toMatch(/secret internal detail|stack/i);
      expect(await Notification.countDocuments()).toBe(0);
      spy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('rate limiting', () => {
    beforeEach(() => {
      process.env.ENABLE_RATE_LIMIT_TESTS = 'true';
    });
    afterEach(() => {
      delete process.env.ENABLE_RATE_LIMIT_TESTS;
    });

    it('allows 5 accepted submissions per window then answers 429 with Retry-After; typos do not use up the quota', async () => {
      const send = (i: number) => request(app).post(URL).send({ ...valid(), message: `Distinct enquiry number ${i} about bulk invitations.` });

      // A visitor fixing validation mistakes must not be locked out
      for (let i = 0; i < 4; i++) expect((await request(app).post(URL).send({ ...valid(), email: 'oops' })).status).toBe(400);

      for (let i = 1; i <= 5; i++) expect((await send(i)).status).toBe(201);

      const blocked = await send(6);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ success: false, message: expect.stringMatching(/too many messages/i) });
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(await ContactMessage.countDocuments()).toBe(5);
    });
  });
});
