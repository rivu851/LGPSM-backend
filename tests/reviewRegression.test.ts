import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import sharp from 'sharp';
import * as xlsx from 'xlsx';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Session, InviteeSource } from '../src/models/Session';
import { Invitee } from '../src/models/Invitee';
import { Category } from '../src/models/Category';
import { Template } from '../src/models/Template';
import { CheckIn } from '../src/models/CheckIn';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

jest.mock('../src/utils/email.provider', () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
}));

let mongoServer: MongoMemoryServer;
let admin: any, organizer: any, otherOrganizer: any;
let adminToken: string, organizerToken: string, otherToken: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

function sheet(rows: (string | number)[][]): Buffer {
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'Invitees');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function makeEvent(ownerId: unknown) {
  const start = new Date(Date.now() + 86400e3);
  return Event.create({
    organizerId: ownerId, title: 'Review Event', description: 'd', categoryId: new mongoose.Types.ObjectId(),
    format: 'PHYSICAL', schedule: { start, end: new Date(start.getTime() + 8 * 3600e3) }
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  admin = await User.create({ fullName: 'Admin', email: 'admin.review@example.com', role: Role.ADMIN });
  organizer = await User.create({ fullName: 'Org', email: 'org.review@example.com', role: Role.ORGANIZER });
  otherOrganizer = await User.create({ fullName: 'Other', email: 'other.review@example.com', role: Role.ORGANIZER });
  adminToken = generateAccessToken(String(admin._id), Role.ADMIN);
  organizerToken = generateAccessToken(String(organizer._id), Role.ORGANIZER);
  otherToken = generateAccessToken(String(otherOrganizer._id), Role.ORGANIZER);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Self-registration', () => {
  it.each(['ADMIN', 'SYSTEM_USER'])('cannot create %s accounts', async (role) => {
    const res = await request(app).post('/api/auth/register').send({ fullName: 'Someone', email: `x-${role}@example.com`, password: 'Password123!', role });
    expect(res.status).toBe(403);
    expect(await User.findOne({ email: `x-${role}@example.com` })).toBeNull();
  });

  it('creates organizers', async () => {
    const res = await request(app).post('/api/auth/register').send({ fullName: 'New Org', email: 'new.org@example.com', password: 'Password123!' });
    expect(res.status).toBe(201);
    expect((await User.findOne({ email: 'new.org@example.com' }))?.role).toBe(Role.ORGANIZER);
  });
});

describe('Categories', () => {
  it('adds a subcategory without changing existing subcategory ids', async () => {
    const cat = await Category.create({ name: 'Corporate Review', subcategories: [{ name: 'Conference' }] });
    const originalId = String((cat as any).subcategories[0]._id);
    const res = await request(app).post(`/api/v1/categories/${cat._id}/subcategories`).set(bearer(adminToken)).send({ name: 'Workshop' });
    expect(res.status).toBe(201);
    const ids = res.body.data.subcategories.map((s: any) => s._id);
    expect(ids).toContain(originalId);
    expect(res.body.data.subcategories.map((s: any) => s.name)).toEqual(['Conference', 'Workshop']);

    const dup = await request(app).post(`/api/v1/categories/${cat._id}/subcategories`).set(bearer(adminToken)).send({ name: 'workshop' });
    expect(dup.status).toBe(409);
    const forbidden = await request(app).post(`/api/v1/categories/${cat._id}/subcategories`).set(bearer(organizerToken)).send({ name: 'Other' });
    expect(forbidden.status).toBe(403);
  });

  it('rejects case-insensitive duplicate category names with 409', async () => {
    await request(app).post('/api/v1/categories').set(bearer(adminToken)).send({ name: 'Social Review' });
    const res = await request(app).post('/api/v1/categories').set(bearer(adminToken)).send({ name: 'social review' });
    expect(res.status).toBe(409);
  });
});

describe('Media', () => {
  it('stores a real image and serves it cross-origin; rejects non-images and wrong roles', async () => {
    const png = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#ff651d' } }).png().toBuffer();
    const up = await request(app).post('/api/v1/media/upload').set(bearer(adminToken)).field('purpose', 'TEMPLATE').attach('file', png, { filename: 'card.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.data.key).toMatch(/^media:[0-9a-f]{24}$/);

    const id = up.body.data.key.slice(6);
    const served = await request(app).get(`/api/v1/media/${id}`);
    expect(served.status).toBe(200);
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(served.headers['content-type']).toMatch(/^image\//);

    const fake = await request(app).post('/api/v1/media/upload').set(bearer(adminToken)).field('purpose', 'TEMPLATE').attach('file', Buffer.from('not an image'), { filename: 'x.png', contentType: 'image/png' });
    expect(fake.status).toBe(400);
    const role = await request(app).post('/api/v1/media/upload').set(bearer(organizerToken)).field('purpose', 'TEMPLATE').attach('file', png, { filename: 'card.png', contentType: 'image/png' });
    expect(role.status).toBe(403);
  });
});

describe('Templates', () => {
  it('keeps drafts visible to admins only and separate from deletion', async () => {
    const created = await request(app).post('/api/v1/templates').set(bearer(adminToken)).send({ name: 'Draft Card', isPublished: false });
    expect(created.status).toBe(201);
    const adminList = await request(app).get('/api/v1/templates').set(bearer(adminToken));
    expect(adminList.body.data.some((t: any) => t.name === 'Draft Card')).toBe(true);
    const orgList = await request(app).get('/api/v1/templates').set(bearer(organizerToken));
    expect(orgList.body.data.some((t: any) => t.name === 'Draft Card')).toBe(false);

    await request(app).patch(`/api/v1/templates/${created.body.data._id}`).set(bearer(adminToken)).send({ isPublished: true });
    const orgAfter = await request(app).get('/api/v1/templates').set(bearer(organizerToken));
    expect(orgAfter.body.data.some((t: any) => t.name === 'Draft Card')).toBe(true);

    await request(app).delete(`/api/v1/templates/${created.body.data._id}`).set(bearer(adminToken));
    const adminAfterDelete = await request(app).get('/api/v1/templates').set(bearer(adminToken));
    expect(adminAfterDelete.body.data.some((t: any) => t.name === 'Draft Card')).toBe(false);
  });

  it('rejects arbitrary preview image references', async () => {
    const res = await request(app).post('/api/v1/templates').set(bearer(adminToken)).send({ name: 'Bad Image', previewImageKey: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(await Template.findOne({ name: 'Bad Image' })).toBeNull();
  });
});

describe('Invitee import', () => {
  it('replaces the not-yet-invited list but never removes invited guests', async () => {
    const event = await makeEvent(organizer._id);
    await Session.create({ eventId: event._id, name: 'Entry', schedule: event.schedule });
    await Invitee.create({ eventId: event._id, name: 'Already Invited', email: 'invited@x.com', invitationStatus: 'SENT', rsvpStatus: 'ACCEPTED' });

    const first = await request(app).post(`/api/v1/events/${event._id}/invitees/import`).set(bearer(organizerToken))
      .attach('file', sheet([['Name', 'Email', 'Mobile'], ['Ann One', 'ann@x.com', ''], ['Ben Two', 'ben@x.com', '']]), 'a.xlsx');
    expect(first.status).toBe(200);
    expect(first.body.data.imported).toBe(2);

    const second = await request(app).post(`/api/v1/events/${event._id}/invitees/import`).set(bearer(organizerToken))
      .attach('file', sheet([['Email', 'Name'], ['cara@x.com', 'Cara Three'], ['ann@x.com', 'Ann Renamed']]), 'b.xlsx');
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ imported: 1, updated: 1, removed: 1 });

    const names = (await Invitee.find({ eventId: event._id }).sort({ name: 1 })).map((i) => i.name);
    expect(names).toEqual(['Already Invited', 'Ann Renamed', 'Cara Three']);
    const invited = await Invitee.findOne({ eventId: event._id, email: 'invited@x.com' });
    expect(invited?.invitationStatus).toBe('SENT');
    expect(invited?.rsvpStatus).toBe('ACCEPTED');
  });

  it('keeps the current list when every row of the new file is invalid', async () => {
    const event = await makeEvent(organizer._id);
    await request(app).post(`/api/v1/events/${event._id}/invitees/import`).set(bearer(organizerToken))
      .attach('file', sheet([['Name', 'Email'], ['Dan Four', 'dan@x.com']]), 'a.xlsx');
    const bad = await request(app).post(`/api/v1/events/${event._id}/invitees/import`).set(bearer(organizerToken))
      .attach('file', sheet([['Name', 'Email'], ['', 'nobody@x.com']]), 'b.xlsx');
    expect(bad.body.data.rejected).toBe(1);
    expect(await Invitee.countDocuments({ eventId: event._id })).toBe(1);
  });

  it('scopes a session upload to that session and lets admins import for any event', async () => {
    const event = await makeEvent(organizer._id);
    const s1 = await Session.create({ eventId: event._id, name: 'Entry', schedule: event.schedule });
    const s2 = await Session.create({ eventId: event._id, name: 'Lunch', schedule: event.schedule });
    const res = await request(app).post(`/api/v1/events/${event._id}/invitees/import`).set(bearer(adminToken))
      .field('sessionId', String(s2._id))
      .attach('file', sheet([['Name', 'Email'], ['Lunch Guest', 'lunch@x.com']]), 'lunch.xlsx');
    expect(res.status).toBe(200);
    const guest = await Invitee.findOne({ eventId: event._id, email: 'lunch@x.com' });
    expect(guest?.sessionAccess.map((a) => String(a.sessionId))).toEqual([String(s2._id)]);
    expect(guest?.sessionAccess.some((a) => String(a.sessionId) === String(s1._id))).toBe(false);

    const other = await request(app).post(`/api/v1/events/${event._id}/invitees/import`).set(bearer(otherToken))
      .attach('file', sheet([['Name', 'Email'], ['X Y', 'xy@x.com']]), 'x.xlsx');
    expect(other.status).toBe(404);
  });
});

describe('Sessions', () => {
  it('allows access validation on the first session only', async () => {
    const event = await makeEvent(organizer._id);
    const body = (name: string, extra: object = {}) => ({ name, schedule: { start: event.schedule.start.toISOString(), end: event.schedule.end.toISOString() }, ...extra });
    const first = await request(app).post(`/api/v1/events/${event._id}/sessions`).set(bearer(organizerToken)).send(body('Entry', { validateAgainstOtherSessions: true }));
    expect(first.status).toBe(201);
    const second = await request(app).post(`/api/v1/events/${event._id}/sessions`).set(bearer(organizerToken)).send(body('Lunch', { validateAgainstOtherSessions: true }));
    expect(second.status).toBe(400);
  });

  it('resolves "keep same invitees" through the source session at check-in and keeps access when the source is deleted', async () => {
    const event = await makeEvent(organizer._id);
    await Event.updateOne({ _id: event._id }, { status: 'PUBLISHED' });
    const s1 = await Session.create({ eventId: event._id, name: 'Entry', schedule: event.schedule });
    const s2 = await Session.create({ eventId: event._id, name: 'Lunch', schedule: event.schedule });
    const copy = await request(app).post(`/api/v1/events/${event._id}/sessions`).set(bearer(organizerToken)).send({
      name: 'Dinner', schedule: { start: event.schedule.start.toISOString(), end: event.schedule.end.toISOString() },
      inviteeSource: InviteeSource.COPY_SESSION, sourceSessionId: String(s2._id)
    });
    expect(copy.status).toBe(201);
    const dinnerId = copy.body.data._id;

    const chain = await request(app).post(`/api/v1/events/${event._id}/sessions`).set(bearer(organizerToken)).send({
      name: 'Late', schedule: { start: event.schedule.start.toISOString(), end: event.schedule.end.toISOString() },
      inviteeSource: InviteeSource.COPY_SESSION, sourceSessionId: dinnerId
    });
    expect(chain.status).toBe(400);

    const token = generateSecureToken();
    const lunchGuest = await Invitee.create({ eventId: event._id, name: 'Lunch Guest', email: 'lg@x.com', qrTokenHash: hashToken(token), rsvpStatus: 'ACCEPTED', sessionAccess: [{ sessionId: s2._id, allowed: true }] });
    const entryOnly = generateSecureToken();
    await Invitee.create({ eventId: event._id, name: 'Entry Guest', email: 'eg@x.com', qrTokenHash: hashToken(entryOnly), rsvpStatus: 'ACCEPTED', sessionAccess: [{ sessionId: s1._id, allowed: true }] });

    const ok = await request(app).post('/api/v1/checkins/scan').set(bearer(organizerToken)).send({ qrCode: token, sessionId: dinnerId });
    expect(ok.status).toBe(201);
    const denied = await request(app).post('/api/v1/checkins/scan').set(bearer(organizerToken)).send({ qrCode: entryOnly, sessionId: dinnerId });
    expect(denied.status).toBe(403);

    await CheckIn.deleteMany({ eventId: event._id });
    const del = await request(app).delete(`/api/v1/sessions/${s2._id}`).set(bearer(organizerToken));
    expect(del.status).toBe(200);
    const dinner = await Session.findById(dinnerId);
    expect(dinner?.inviteeSource).toBe(InviteeSource.NEW_LIST);
    const refreshed = await Invitee.findById(lunchGuest._id);
    expect(refreshed?.sessionAccess.some((a) => String(a.sessionId) === dinnerId && a.allowed)).toBe(true);
    expect(refreshed?.sessionAccess.some((a) => String(a.sessionId) === String(s2._id))).toBe(false);
  });
});

describe('Invitation dates', () => {
  it('formats server-rendered times in the platform time zone', async () => {
    const { formatCardTime } = await import('../src/utils/invitationContent');
    // 04:30 UTC is 10:00 in Asia/Kolkata (the default APP_TIMEZONE)
    expect(formatCardTime(new Date('2026-11-10T04:30:00Z'))).toBe('10:00 AM');
  });
});

