import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { invitationService } from '../src/services/invitation.service';
import { Event } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation, DeliveryChannel, InvitationDeliveryStatus } from '../src/models/Invitation';
import { User, Role } from '../src/models/User';
import { generateAccessToken } from '../src/utils/token';
import { sendEmail } from '../src/utils/email.provider';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

// Clearing the delivery history only hides it: Resend addresses records by id, and check-in uses them to tell a
// superseded QR code from an unknown one, so the records themselves must survive.
describe('Clear invitation delivery history', () => {
  jest.setTimeout(60000);
  let mongoServer: MongoMemoryServer;
  let owner: any, other: any, admin: any, eventId: string, inviteeIds: string[];

  const auth = (u: any) => `Bearer ${generateAccessToken(String(u._id), u.role)}`;
  const url = () => `/api/v1/events/${eventId}/invitations`;
  const visible = async (u: any = owner) => (await request(app).get(url()).set('Authorization', auth(u))).body.invitations;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([User.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({}), Invitation.deleteMany({})]);
    owner = await User.create({ fullName: 'Owner', email: 'owner.hist@example.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
    other = await User.create({ fullName: 'Other', email: 'other.hist@example.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
    admin = await User.create({ fullName: 'Root', email: 'root.hist@example.com', role: Role.ADMIN, isActive: true, isEmailVerified: true });
    const event = await Event.create({
      organizerId: owner._id, title: 'History Event', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL' as any,
      schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) }
    });
    eventId = String(event._id);
    const invitees = await Invitee.insertMany(
      ['a', 'b'].map((n) => ({ eventId: event._id, name: `Guest ${n}`, email: `${n}@example.com`, invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING }))
    );
    inviteeIds = invitees.map((i) => String(i._id));
    await invitationService.sendInvitations(eventId, String(owner._id), inviteeIds, DeliveryChannel.EMAIL);
  });

  it('hides every entry from the history list and reports how many it cleared', async () => {
    expect(await visible()).toHaveLength(2);
    const res = await request(app).delete(`${url()}/history`).set('Authorization', auth(owner));
    expect(res.status).toBe(200);
    expect(res.body.data.cleared).toBe(2);
    // The list endpoint still returns the records (Resend needs their ids); each one is marked cleared
    const after = await visible();
    expect(after).toHaveLength(2);
    expect(after.every((i: any) => !!i.clearedAt)).toBe(true);
  });

  it('keeps the records, so Resend still works for a guest whose history was cleared', async () => {
    await request(app).delete(`${url()}/history`).set('Authorization', auth(owner));
    expect(await Invitation.countDocuments({ eventId })).toBe(2);

    const record = await Invitation.findOne({ inviteeId: inviteeIds[0] });
    const results = await invitationService.resendInvitations(eventId, String(owner._id), [String(record!._id)]);
    expect(results[0].status).toBe(InvitationDeliveryStatus.SENT);
    expect(sendEmail).toHaveBeenCalled();
  });

  it('shows a resent guest in the history again (as a new entry) but not the guests that were not resent', async () => {
    await request(app).delete(`${url()}/history`).set('Authorization', auth(owner));
    const record = await Invitation.findOne({ inviteeId: inviteeIds[0] });
    await invitationService.resendInvitations(eventId, String(owner._id), [String(record!._id)]);

    // A resend writes a new record; the old one stays cleared so the guest is not listed twice
    const visibleNow = (await visible()).filter((i: any) => !i.clearedAt);
    expect(visibleNow).toHaveLength(1);
    expect(String(visibleNow[0].inviteeId._id)).toBe(inviteeIds[0]);
    expect(await Invitation.countDocuments({ eventId, inviteeId: inviteeIds[0] })).toBe(2);
  });

  it('shows a guest again after a new send', async () => {
    await request(app).delete(`${url()}/history`).set('Authorization', auth(owner));
    await invitationService.sendInvitations(eventId, String(owner._id), [inviteeIds[1]], DeliveryChannel.EMAIL);
    const record = await Invitation.findOne({ inviteeId: inviteeIds[1] });
    expect(record?.clearedAt).toBeUndefined();
  });

  it('is idempotent: clearing an already cleared history changes nothing', async () => {
    await request(app).delete(`${url()}/history`).set('Authorization', auth(owner));
    const again = await request(app).delete(`${url()}/history`).set('Authorization', auth(owner));
    expect(again.status).toBe(200);
    expect(again.body.data.cleared).toBe(0);
  });

  it('keeps the superseded-QR lookup intact, because the token hashes are untouched', async () => {
    const before = await Invitation.find({ eventId }).lean();
    await request(app).delete(`${url()}/history`).set('Authorization', auth(owner));
    const after = await Invitation.find({ eventId }).lean();
    expect(after.map((i) => i.tokenHash).sort()).toEqual(before.map((i) => i.tokenHash).sort());
    expect(await Invitation.exists({ tokenHash: before[0].tokenHash })).toBeTruthy();
  });

  it("does not let another organizer clear someone else's history", async () => {
    const res = await request(app).delete(`${url()}/history`).set('Authorization', auth(other));
    expect(res.status).toBe(404);
    expect(await Invitation.countDocuments({ eventId, clearedAt: { $exists: true } })).toBe(0);
  });

  it('requires authentication and allows an admin', async () => {
    expect((await request(app).delete(`${url()}/history`)).status).toBe(401);
    expect((await request(app).delete(`${url()}/history`).set('Authorization', auth(admin))).status).toBe(200);
  });

  it('refuses system users', async () => {
    const staff = await User.create({ fullName: 'Staff', email: 'staff.hist@example.com', role: Role.SYSTEM_USER, isActive: true, isEmailVerified: true });
    expect((await request(app).delete(`${url()}/history`).set('Authorization', auth(staff))).status).toBe(403);
  });
});
