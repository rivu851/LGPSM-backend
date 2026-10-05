import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { Event } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

describe('Public Invitation & RSVP Endpoints', () => {
  let mongoServer: MongoMemoryServer;
  let eventId: mongoose.Types.ObjectId;
  let inviteeId: mongoose.Types.ObjectId;
  let rawToken: string;
  let tokenHash: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Event.deleteMany({});
    await Invitee.deleteMany({});

    const organizerId = new mongoose.Types.ObjectId();
    const event = await Event.create({
      organizerId,
      title: 'Grand Gala 2026',
      description: 'Annual celebration',
      categoryId: new mongoose.Types.ObjectId(),
      format: 'PHYSICAL' as any,
      location: { type: 'Point', address: 'Convention Hall, City', coordinates: [0, 0] } as any,
      // RSVP is only accepted while the event has it enabled and before it closes
      schedule: { start: new Date(), end: new Date(Date.now() + 86400e3) },
      rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: false, allowDeclined: false }
    });
    eventId = (event as any)._id as mongoose.Types.ObjectId;

    rawToken = generateSecureToken();
    tokenHash = hashToken(rawToken);

    const invitee = await Invitee.create({
      eventId,
      name: 'John Guest',
      email: 'john@example.com',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.PENDING,
      qrTokenHash: tokenHash
    });
    inviteeId = (invitee as any)._id as mongoose.Types.ObjectId;
  });

  describe('GET /api/v1/public/invitations/:token', () => {
    it('should retrieve sanitized invitation details using valid token', async () => {
      const res = await request(app).get(`/api/v1/public/invitations/${rawToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.event).toBeDefined();
      expect(res.body.data.event.title).toBe('Grand Gala 2026');
      expect(res.body.data.event.description).toBe('Annual celebration');
      expect(res.body.data.invitee).toBeDefined();
      expect(res.body.data.invitee.name).toBe('John Guest');
      expect(res.body.data.invitee.rsvpStatus).toBe('PENDING');

      // Security checks: ensure raw tokens, hashes, and organizer IDs are not leaked
      expect(res.body.data.qrTokenHash).toBeUndefined();
      expect(res.body.data.tokenHash).toBeUndefined();
      expect(res.body.data.token).toBeUndefined();
      expect(res.body.data.event.organizerId).toBeUndefined();
    });

    it('should return 404 for invalid or unknown token', async () => {
      const invalidToken = generateSecureToken();
      const res = await request(app).get(`/api/v1/public/invitations/${invalidToken}`);

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invitation not found or token is invalid');
    });
  });

  describe('POST /api/v1/public/invitations/:token/rsvp', () => {
    it('should successfully submit ACCEPTED RSVP', async () => {
      const res = await request(app)
        .post(`/api/v1/public/invitations/${rawToken}/rsvp`)
        .send({ rsvpStatus: 'ACCEPTED', dietaryPreference: 'Vegan' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.rsvpStatus).toBe('ACCEPTED');
      expect(res.body.data.dietaryPreference).toBe('Vegan');

      // Verify DB persistence
      const updatedInvitee = await Invitee.findById(inviteeId);
      expect(updatedInvitee?.rsvpStatus).toBe(RsvpStatus.ACCEPTED);
      expect(updatedInvitee?.dietaryPreference).toBe('Vegan');
    });

    it('should successfully submit DECLINED RSVP', async () => {
      const res = await request(app)
        .post(`/api/v1/public/invitations/${rawToken}/rsvp`)
        .send({ rsvpStatus: 'DECLINED' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.rsvpStatus).toBe('DECLINED');

      const updatedInvitee = await Invitee.findById(inviteeId);
      expect(updatedInvitee?.rsvpStatus).toBe(RsvpStatus.DECLINED);
    });

    it('should return 400 for invalid RSVP status choice', async () => {
      const res = await request(app)
        .post(`/api/v1/public/invitations/${rawToken}/rsvp`)
        .send({ rsvpStatus: 'MAYBE' });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
    });

    it('should return 404 when submitting RSVP for unknown token', async () => {
      const invalidToken = generateSecureToken();
      const res = await request(app)
        .post(`/api/v1/public/invitations/${invalidToken}/rsvp`)
        .send({ rsvpStatus: 'ACCEPTED' });

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });
});
