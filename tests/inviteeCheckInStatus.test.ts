import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { CheckIn, CheckInMethod } from '../src/models/CheckIn';
import { generateAccessToken } from '../src/utils/token';

// Covers the invitee list's check-in-status join used by the mobile check-in
// scanner's All/Checked-in/Pending filters — this is a real aggregation
// pipeline ($lookup + $facet), not a mocked unit test, so it also verifies
// the pipeline itself is syntactically and semantically correct against a
// real MongoDB instance.
describe('Invitees — server-side check-in status filter/pagination', () => {
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
    await CheckIn.deleteMany({});

    organizer = await User.create({
      fullName: 'Organizer',
      email: 'organizer@example.com',
      role: Role.ORGANIZER,
      isActive: true,
    });
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

  // each guest of an event has their own phone number (the database allows one active guest per number)
  let phoneSeq = 0;
  async function makeInvitee(name: string) {
    return Invitee.create({
      eventId: event._id,
      name,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      mobile: `90000${String(10000 + ++phoneSeq)}`,
      invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED,
    });
  }

  it('reports isCheckedIn=false for an invitee with no check-in record', async () => {
    const invitee = await makeInvitee('Alice Pending');

    const res = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionId: String(sessionA._id) })
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    const row = res.body.data.find((i: any) => i._id === String(invitee._id));
    expect(row.isCheckedIn).toBe(false);
  });

  it('reports isCheckedIn=true only for the session the invitee actually checked into', async () => {
    const invitee = await makeInvitee('Bob Checked In');
    await CheckIn.create({
      eventId: event._id,
      inviteeId: invitee._id,
      sessionId: sessionA._id,
      checkInMethod: CheckInMethod.QR,
      checkedInBy: organizer._id,
    });

    const resSessionA = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionId: String(sessionA._id) })
      .set('Authorization', `Bearer ${organizerToken}`);
    const rowA = resSessionA.body.data.find((i: any) => i._id === String(invitee._id));
    expect(rowA.isCheckedIn).toBe(true);
    expect(rowA.checkedInAt).toBeTruthy();

    // Same invitee, different session — must not leak the Session A check-in.
    const resSessionB = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionId: String(sessionB._id) })
      .set('Authorization', `Bearer ${organizerToken}`);
    const rowB = resSessionB.body.data.find((i: any) => i._id === String(invitee._id));
    expect(rowB.isCheckedIn).toBe(false);
  });

  it('filters to only CHECKED_IN or only PENDING and paginates the filtered set correctly', async () => {
    const checkedIn = await Promise.all(
      Array.from({ length: 3 }, (_, i) => makeInvitee(`CheckedIn ${i}`))
    );
    const pending = await Promise.all(Array.from({ length: 5 }, (_, i) => makeInvitee(`Pending ${i}`)));

    await Promise.all(
      checkedIn.map((inv) =>
        CheckIn.create({
          eventId: event._id,
          inviteeId: inv._id,
          sessionId: sessionA._id,
          checkInMethod: CheckInMethod.MANUAL,
          checkedInBy: organizer._id,
        })
      )
    );

    const checkedInRes = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionId: String(sessionA._id), checkInStatus: 'CHECKED_IN', limit: 2, page: 1 })
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(checkedInRes.status).toBe(200);
    expect(checkedInRes.body.data.length).toBe(2);
    expect(checkedInRes.body.meta.total).toBe(3);
    expect(checkedInRes.body.data.every((i: any) => i.isCheckedIn === true)).toBe(true);

    const pendingRes = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionId: String(sessionA._id), checkInStatus: 'PENDING' })
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(pendingRes.status).toBe(200);
    expect(pendingRes.body.meta.total).toBe(5);
    expect(pendingRes.body.data.every((i: any) => i.isCheckedIn === false)).toBe(true);
    expect(pendingRes.body.data.map((i: any) => i._id).sort()).toEqual(
      pending.map((i) => String(i._id)).sort()
    );
  });

  it('combines the check-in-status join with the existing name/email/mobile search filter', async () => {
    const target = await makeInvitee('Zara Findme');
    await makeInvitee('Someone Else');

    const res = await request(app)
      .get(`/api/v1/events/${event._id}/invitees`)
      .query({ sessionId: String(sessionA._id), search: 'findme' })
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0]._id).toBe(String(target._id));
  });
});
