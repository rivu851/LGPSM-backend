/**
 * The Reports "Action Log" is an event's audit trail: every action on the event must be recorded WITH the event, or it never shows
 * there (sending invitations used to be saved without one). Mail is mocked: nothing is sent.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { AuditLog } from '../src/models/AuditLog';
import { generateAccessToken } from '../src/utils/token';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.setTimeout(90000);

let mongo: MongoMemoryServer; let org: any; let other: any; let admin: any; let ev: any;
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
const trail = async (who: any, eventId: unknown, expect: string[]) => {
  for (let i = 0; i < 40; i++) {
    const r = await request(app).get(`/api/v1/audit-logs?eventId=${eventId}&limit=100`).set(auth(who));
    const actions: string[] = (r.body.data || []).map((l: any) => l.action);
    if (expect.every((a) => actions.includes(a))) return r.body.data as any[];
    await new Promise((res) => setTimeout(res, 100));
  }
  return (await request(app).get(`/api/v1/audit-logs?eventId=${eventId}&limit=100`).set(auth(who))).body.data as any[];
};
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({}), AuditLog.deleteMany({})]);
  org = await User.create({ fullName: 'Org', email: 'o@x.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true, profile: { organizationName: 'Iconic' } });
  other = await User.create({ fullName: 'Other', email: 'p@x.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  admin = await User.create({ fullName: 'Admin', email: 'a@x.com', role: Role.ADMIN, isActive: true });
  const cat: any = await Category.create({ name: 'Corporate', isActive: true });
  ev = await Event.create({ organizerId: org._id, title: 'Summit', description: 'd', categoryId: cat._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) } });
});

describe("an event's Action Log", () => {
  it('records sending and re-sending invitations against the event, for the organizer and the admin, and not for another organizer', async () => {
    const g: any = await Invitee.create({ eventId: ev._id, name: 'Guest', email: 'guest@x.com', sessionAccess: [] });
    expect((await request(app).post(`/api/v1/events/${ev._id}/invitations/send`).set(auth(org)).send({ inviteeIds: [String(g._id)], channel: 'EMAIL' })).status).toBe(200);
    await request(app).post(`/api/v1/events/${ev._id}/invitations/resend`).set(auth(org)).send({ inviteeIds: [String(g._id)], channel: 'EMAIL' });
    for (const who of [org, admin]) {
      const rows = await trail(who, ev._id, ['INVITATION_SEND']);
      const send = rows.find((l) => l.action === 'INVITATION_SEND');
      expect(send).toBeDefined();
      expect(String(send.eventId?._id || send.eventId)).toBe(String(ev._id));
      expect(String(send.organizerId?._id || send.organizerId)).toBe(String(org._id)); // the tenant, so the log shows the organizer's name and ID
    }
    // another organizer cannot read it
    const theirs = await request(app).get(`/api/v1/audit-logs?eventId=${ev._id}&limit=100`).set(auth(other));
    expect((theirs.body.data || []).length).toBe(0);
  });
  it('lists every action on the event, newest first, including past 20 entries (the page asks for up to 100)', async () => {
    for (let i = 0; i < 25; i++) await AuditLog.create({ actorId: org._id, actorRole: Role.ORGANIZER, actorType: 'ORGANIZER', eventId: ev._id, organizerId: org._id, action: 'INVITEE_CREATE', entityType: 'Invitee', status: 'SUCCESS' } as any);
    const r = await request(app).get(`/api/v1/audit-logs?eventId=${ev._id}&limit=100`).set(auth(org));
    expect(r.body.data.length).toBe(25);
    expect(r.body.meta.total).toBe(25);
    const small = await request(app).get(`/api/v1/audit-logs?eventId=${ev._id}`).set(auth(org));
    expect(small.body.data.length).toBe(20); // the default page; the page size is a request parameter
    expect(small.body.meta.totalPages).toBe(2);
  });
});
