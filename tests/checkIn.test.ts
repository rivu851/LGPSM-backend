import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { CheckIn } from '../src/models/CheckIn';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';
import { invitationUrlFor } from '../src/utils/qrPayload';

describe('Phase 6 — Step 12: Check-in, Access Validation & Logs', () => {
  let mongoServer: MongoMemoryServer;

  // Test Entities
  let organizer: any;
  let organizerToken: string;
  let staffUser: any;
  let staffToken: string;
  let unauthorizedUser: any;
  let unauthorizedToken: string;

  let event1: any;
  let event2: any;
  let session1: any;
  let session2OnlyOnce: any;
  let session3CrossSession: any;

  let invitee1: any;
  let rawToken1: string;
  let tokenHash1: string;

  let invitee2Restricted: any;
  let rawToken2: string;
  let tokenHash2: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    await Session.deleteMany({});
    await Invitee.deleteMany({});
    await SystemUserAssignment.deleteMany({});
    await CheckIn.deleteMany({});

    // 1. Setup Users
    organizer = await User.create({
      fullName: 'Organizer Alice',
      email: 'organizer@example.com',
      role: Role.ORGANIZER,
      isActive: true
    });
    organizerToken = generateAccessToken(organizer._id.toString(), organizer.role);

    staffUser = await User.create({
      fullName: 'Staff Bob',
      email: 'staff@example.com',
      role: Role.SYSTEM_USER,
      isActive: true
    });
    staffToken = generateAccessToken(staffUser._id.toString(), staffUser.role);

    unauthorizedUser = await User.create({
      fullName: 'Other User',
      email: 'other@example.com',
      role: Role.ORGANIZER,
      isActive: true
    });
    unauthorizedToken = generateAccessToken(unauthorizedUser._id.toString(), unauthorizedUser.role);

    // 2. Setup Events
    event1 = await Event.create({
      organizerId: organizer._id,
      title: 'Tech Conference 2026',
      description: 'Annual Tech Summit',
      categoryId: new mongoose.Types.ObjectId(),
      format: EventFormat.PHYSICAL,
      schedule: { start: new Date(), end: new Date() },
      rsvp: {
        enabled: true,
        allowAllInvited: true,
        allowNotResponded: true,
        allowDeclined: false
      },
      status: EventStatus.PUBLISHED
    });

    event2 = await Event.create({
      organizerId: unauthorizedUser._id,
      title: 'Different Event',
      description: 'Private Gala',
      categoryId: new mongoose.Types.ObjectId(),
      format: EventFormat.PHYSICAL,
      schedule: { start: new Date(), end: new Date() },
      status: EventStatus.PUBLISHED
    });

    // 3. Setup Sessions for Event 1
    session1 = await Session.create({
      eventId: event1._id,
      name: 'Keynote Session',
      schedule: { start: new Date(), end: new Date() },
      accessControl: AccessControl.NO_RESTRICTION,
      validateAgainstOtherSessions: false,
      inviteeSource: InviteeSource.NEW_LIST
    });

    session2OnlyOnce = await Session.create({
      eventId: event1._id,
      name: 'VIP Workshop',
      schedule: { start: new Date(), end: new Date() },
      accessControl: AccessControl.ONLY_ONCE,
      validateAgainstOtherSessions: false,
      inviteeSource: InviteeSource.NEW_LIST
    });

    session3CrossSession = await Session.create({
      eventId: event1._id,
      name: 'Exclusive Roundtable',
      schedule: { start: new Date(), end: new Date() },
      accessControl: AccessControl.NO_RESTRICTION,
      validateAgainstOtherSessions: true,
      inviteeSource: InviteeSource.NEW_LIST
    });

    // 4. Assign Staff to Event 1 and Session 1 & 2 only
    await SystemUserAssignment.create({
      userId: staffUser._id,
      eventId: event1._id,
      sessionIds: [session1._id, session2OnlyOnce._id],
      assignedBy: organizer._id
    });

    // 5. Setup Invitees
    rawToken1 = generateSecureToken();
    tokenHash1 = hashToken(rawToken1);
    invitee1 = await Invitee.create({
      eventId: event1._id,
      name: 'John Guest',
      email: 'john@example.com',
      mobile: '+1234567890',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
      qrTokenHash: tokenHash1,
      sessionAccess: []
    });

    rawToken2 = generateSecureToken();
    tokenHash2 = hashToken(rawToken2);
    invitee2Restricted = await Invitee.create({
      eventId: event1._id,
      name: 'Jane Restricted',
      email: 'jane@example.com',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
      qrTokenHash: tokenHash2,
      sessionAccess: [
        { sessionId: session1._id, allowed: true },
        { sessionId: session2OnlyOnce._id, allowed: false }
      ]
    });
  });

  describe('QR-Based Check-In (POST /api/v1/checkins/scan)', () => {
    it('should successfully check in invitee using valid QR raw token string', async () => {
      const res = await request(app)
        .post('/api/v1/checkins/scan')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          qrCode: rawToken1,
          eventId: event1._id.toString()
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitee.name).toBe('John Guest');
      expect(res.body.data.checkInMethod).toBe('QR');

      // Security check: raw token and hash must not be leaked
      expect(res.body.data.qrTokenHash).toBeUndefined();
      expect(res.body.data.tokenHash).toBeUndefined();

      // Verify DB record
      const checkInRecord = await CheckIn.findOne({ inviteeId: invitee1._id });
      expect(checkInRecord).toBeDefined();
      expect(checkInRecord?.checkedInBy.toString()).toBe(organizer._id.toString());
    });

    it('should reject QR URLs that point at a host other than the invitation site', async () => {
      const res = await request(app)
        .post('/api/v1/checkins/scan')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ qrCode: `https://myapp.com/invitation/${rawToken1}`, sessionId: session1._id.toString() });

      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('QR_URL_UNTRUSTED');
    });

    it('should extract raw token from QR URL format correctly', async () => {
      const qrUrl = invitationUrlFor(rawToken1);
      const res = await request(app)
        .post('/api/v1/checkins/scan')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          qrCode: qrUrl,
          sessionId: session1._id.toString()
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.session._id).toBe(session1._id.toString());
    });

    it('should reject scan with 404 if QR token is invalid', async () => {
      const invalidToken = generateSecureToken();
      const res = await request(app)
        .post('/api/v1/checkins/scan')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ qrCode: invalidToken });

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_QR_TOKEN');
    });

    it('should reject scan if specified eventId does not match QR token event', async () => {
      const res = await request(app)
        .post('/api/v1/checkins/scan')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          qrCode: rawToken1,
          eventId: event2._id.toString()
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('QR token does not belong');
    });
  });

  describe('Manual Check-In (POST /api/v1/checkins/manual)', () => {
    it('should successfully check in invitee manually using inviteeId', async () => {
      const res = await request(app)
        .post('/api/v1/checkins/manual')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          eventId: event1._id.toString(),
          inviteeId: invitee1._id.toString(),
          sessionId: session1._id.toString()
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitee._id).toBe(invitee1._id.toString());
      expect(res.body.data.checkInMethod).toBe('MANUAL');
    });

    it('should successfully check in invitee manually using email', async () => {
      const res = await request(app)
        .post('/api/v1/checkins/manual')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          eventId: event1._id.toString(),
          email: 'john@example.com'
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitee.email).toBe('john@example.com');
    });

    it('should return 404 if invitee belongs to another event', async () => {
      const invitee2InEvent2 = await Invitee.create({
        eventId: event2._id,
        name: 'Event2 Guest',
        email: 'guest2@example.com',
        invitationStatus: InvitationStatus.SENT,
        rsvpStatus: RsvpStatus.ACCEPTED
      });

      const res = await request(app)
        .post('/api/v1/checkins/manual')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          eventId: event1._id.toString(),
          inviteeId: (invitee2InEvent2._id as any).toString()
        });

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should reject unauthorized user attempting manual check-in', async () => {
      const res = await request(app)
        .post('/api/v1/checkins/manual')
        .set('Authorization', `Bearer ${unauthorizedToken}`)
        .send({
          eventId: event1._id.toString(),
          inviteeId: invitee1._id.toString()
        });

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  describe('Session Permission & Authorization Validation', () => {
    it('should reject check-in if invitee sessionAccess explicitly denies access', async () => {
      const res = await request(app)
        .post('/api/v1/checkins/scan')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          qrCode: rawToken2,
          sessionId: session2OnlyOnce._id.toString()
        });

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Invitee does not have permission');
    });

    it('should ignore client-supplied allowed: true flag and enforce backend DB check', async () => {
      const res = await request(app)
        .post('/api/v1/checkins/scan')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          qrCode: rawToken2,
          sessionId: session2OnlyOnce._id.toString(),
          allowed: true, // Attempted frontend bypass!
          isAuthorized: true
        });

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('should reject staff member checking in guests for a session they are not assigned to', async () => {
      const res = await request(app)
        .post('/api/v1/checkins/manual')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          eventId: event1._id.toString(),
          inviteeId: invitee1._id.toString(),
          sessionId: session3CrossSession._id.toString() // Staff only assigned to session1 & session2
        });

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Staff is not assigned');
    });
  });

  describe('RSVP Eligibility Validation', () => {
    it('should reject check-in if invitee RSVP is DECLINED and event disables declined entry', async () => {
      const declinedInvitee = await Invitee.create({
        eventId: event1._id,
        name: 'Declined Guest',
        email: 'declined@example.com',
        invitationStatus: InvitationStatus.SENT,
        rsvpStatus: RsvpStatus.DECLINED
      });

      const res = await request(app)
        .post('/api/v1/checkins/manual')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          eventId: event1._id.toString(),
          inviteeId: (declinedInvitee._id as any).toString()
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('RSVP is DECLINED');
    });
  });

  describe('ONLY_ONCE & Cross-Session Conflict Validation', () => {
    it('should allow first check-in to ONLY_ONCE session, but reject duplicate attempt with 409 Conflict', async () => {
      // First check-in
      const res1 = await request(app)
        .post('/api/v1/checkins/scan')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          qrCode: rawToken1,
          sessionId: session2OnlyOnce._id.toString()
        });
      expect(res1.statusCode).toBe(201);

      // Duplicate check-in attempt
      const res2 = await request(app)
        .post('/api/v1/checkins/scan')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          qrCode: rawToken1,
          sessionId: session2OnlyOnce._id.toString()
        });

      expect(res2.statusCode).toBe(409);
      expect(res2.body.success).toBe(false);
      expect(res2.body.message).toContain('ONLY_ONCE rule');
    });

    it('requires a check-in to the primary session when it has access validation enabled', async () => {
      // The flag lives on the primary (first-created) session
      await Session.updateOne({ _id: session1._id }, { validateAgainstOtherSessions: true });
      try {
        const denied = await request(app)
          .post('/api/v1/checkins/scan')
          .set('Authorization', `Bearer ${organizerToken}`)
          .send({ qrCode: rawToken1, sessionId: session3CrossSession._id.toString() });
        expect(denied.statusCode).toBe(409);
        expect(denied.body.success).toBe(false);
        expect(denied.body.message).toContain('first session');

        await CheckIn.create({
          eventId: event1._id,
          inviteeId: invitee1._id,
          sessionId: session1._id,
          checkInMethod: 'QR',
          checkedInBy: organizer._id,
          checkInAt: new Date()
        });

        const allowed = await request(app)
          .post('/api/v1/checkins/scan')
          .set('Authorization', `Bearer ${organizerToken}`)
          .send({ qrCode: rawToken1, sessionId: session3CrossSession._id.toString() });
        expect(allowed.statusCode).toBe(201);
      } finally {
        await Session.updateOne({ _id: session1._id }, { validateAgainstOtherSessions: false });
      }
    });

    it('should enforce database-level unique index constraint to prevent concurrent duplicate inserts', async () => {
      // Ensure indexes are built
      await CheckIn.syncIndexes();

      await CheckIn.create({
        eventId: event1._id,
        inviteeId: invitee1._id,
        sessionId: session1._id,
        checkInMethod: 'QR',
        checkedInBy: organizer._id,
        checkInAt: new Date()
      });

      // Attempt direct MongoDB insert of exact same compound key (eventId, inviteeId, sessionId)
      let duplicateError: any = null;
      try {
        await CheckIn.create({
          eventId: event1._id,
          inviteeId: invitee1._id,
          sessionId: session1._id,
          checkInMethod: 'MANUAL',
          checkedInBy: organizer._id,
          checkInAt: new Date()
        });
      } catch (err: any) {
        duplicateError = err;
      }

      expect(duplicateError).toBeDefined();
      expect(duplicateError.code).toBe(11000); // E11000 MongoServerError duplicate key error
    });
  });

  describe('Check-In Record Retrieval (GET /api/v1/events/:eventId/checkins)', () => {
    beforeEach(async () => {
      await CheckIn.create({
        eventId: event1._id,
        inviteeId: invitee1._id,
        sessionId: session1._id,
        checkInMethod: 'QR',
        checkedInBy: organizer._id,
        checkInAt: new Date()
      });
    });

    it('should return paginated check-in records for event organizer', async () => {
      const res = await request(app)
        .get(`/api/v1/events/${event1._id}/checkins`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].invitee.name).toBe('John Guest');
      expect(res.body.data[0].session.name).toBe('Keynote Session');

      // Ensure sensitive token/hash fields are omitted
      expect(res.body.data[0].invitee.qrTokenHash).toBeUndefined();
    });

    it('should filter check-in records by sessionId', async () => {
      const res = await request(app)
        .get(`/api/v1/events/${event1._id}/checkins?sessionId=${session2OnlyOnce._id}`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(0);
    });

    it('should reject unauthorized user attempting to retrieve check-in records', async () => {
      const res = await request(app)
        .get(`/api/v1/events/${event1._id}/checkins`)
        .set('Authorization', `Bearer ${unauthorizedToken}`);

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });
});
