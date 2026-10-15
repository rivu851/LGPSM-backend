import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';

// Covers the invitee list's sessionAccessId filter (invitation-level session
// targeting, used by the Admin/Organizer invitee list screens) combined with
// the existing name/email/mobile search — both built from the same `filter`
// object, so a regression here would mean one silently overwrote the other.
describe('Invitees — sessionAccessId filter', () => {
  let mongoServer: MongoMemoryServer;
  let organizer: any;
  let organizerToken: string;
  let event: any;
  let sessionA: any;
  let sessionB: any;

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

    organizer = await User.create({
      fullName: 'Organizer',
      email: 'organizer@example.com',
      role: Role.ORGANIZER,
      isActive: true,
    });
    const { generateAccessToken } = await import('../src/utils/token');
    organizerToken = generateAccessToken(organizer._id.toString(), organizer.role);

    event = await Event.create({
      organizerId: organizer._id,
      title: 'Conference',
      description: 'Desc',
      categoryId: new mongoose.Types.ObjectId(),
      format: EventFormat.PHYSICAL,
      status: EventStatus.PUBLISHED,
      schedule: { start: new Date('2026-01-01T08:00:00Z'), end: new Date('2026-01-01T20:00:00Z') },
    });

    sessionA = await Session.create({
      eventId: event._id,
      name: 'Session A',
      schedule: { start: new Date('2026-01-01T09:00:00Z'), end: new Date('2026-01-01T10:00:00Z') },
      accessControl: AccessControl.NO_RESTRICTION,
      inviteeSource: InviteeSource.NEW_LIST,
    });
    sessionB = await Session.create({
      eventId: event._id,
      name: 'Session B',
      schedule: { start: new Date('2026-01-01T11:00:00Z'), end: new Date('2026-01-01T12:00:00Z') },
      accessControl: AccessControl.NO_RESTRICTION,
      inviteeSource: InviteeSource.NEW_LIST,
    });
  });

  it('includes an invitee with no sessionAccess entries (invited to every session) in any session filter', async () => {
    const allSessions = await Invitee.create({
      eventId: event._id,
      name: 'Invited To All',
      email: 'all@example.com',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
      sessionAccess: [],
    });

    const res = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionAccessId: String(sessionA._id) })
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((i: any) => i._id)).toContain(String(allSessions._id));
  });

  it('treats a legacy invitee document with no sessionAccess field at all as invited to every session', async () => {
    // Written straight to the collection so Mongoose's [] default never applies.
    const { insertedId } = await Invitee.collection.insertOne({
      eventId: event._id,
      name: 'Legacy Invitee',
      email: 'legacy@example.com',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
      createdAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionAccessId: String(sessionA._id), limit: 1 })
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]._id).toBe(String(insertedId));
  });

  it('excludes an invitee explicitly restricted to a different session', async () => {
    const onlyB = await Invitee.create({
      eventId: event._id,
      name: 'Only Session B',
      email: 'onlyb@example.com',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
      sessionAccess: [{ sessionId: sessionB._id, allowed: true }],
    });
    const onlyA = await Invitee.create({
      eventId: event._id,
      name: 'Only Session A',
      email: 'onlya@example.com',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
      sessionAccess: [{ sessionId: sessionA._id, allowed: true }],
    });

    const res = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionAccessId: String(sessionA._id) })
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((i: any) => i._id);
    expect(ids).toContain(String(onlyA._id));
    expect(ids).not.toContain(String(onlyB._id));
  });

  it('combines sessionAccessId with search without one clobbering the other', async () => {
    const match = await Invitee.create({
      eventId: event._id,
      name: 'Zara Findme',
      email: 'zara@example.com',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
      sessionAccess: [{ sessionId: sessionA._id, allowed: true }],
    });
    // Same name match, but wrong session — must be excluded.
    await Invitee.create({
      eventId: event._id,
      name: 'Zara Findme Too',
      email: 'zara2@example.com',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
      sessionAccess: [{ sessionId: sessionB._id, allowed: true }],
    });
    // Right session, but doesn't match the search term — must be excluded.
    await Invitee.create({
      eventId: event._id,
      name: 'Someone Else',
      email: 'someone@example.com',
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
      sessionAccess: [{ sessionId: sessionA._id, allowed: true }],
    });

    const res = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionAccessId: String(sessionA._id), search: 'findme' })
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0]._id).toBe(String(match._id));
  });
});
