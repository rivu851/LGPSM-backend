/**
 * The organizer-portal rules, checked for the ADMIN role: an administrator manages any organizer's event with the same flows, the
 * same rules and the same messages, only with wider access. Everything goes through the real routes; mail is mocked (nothing sent).
 */
import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import * as xlsx from 'xlsx';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { InviteeSet } from '../src/models/InviteeSet';
import { Session } from '../src/models/Session';
import { AuditLog } from '../src/models/AuditLog';
import { generateAccessToken } from '../src/utils/token';

const mockSendEmail = jest.fn().mockResolvedValue(true);
jest.mock('../src/utils/email.provider', () => ({ sendEmail: (...a: any[]) => mockSendEmail(...a) }));
jest.setTimeout(90000);

let mongo: MongoMemoryServer; let admin: any; let org: any; let corp: any; let ev: any; let past: any;
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
const day = 864e5;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  mockSendEmail.mockClear();
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({}).setOptions({ includeArchived: true } as any), InviteeSet.deleteMany({}), Session.deleteMany({}), AuditLog.deleteMany({})]);
  admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', role: Role.ADMIN, isActive: true });
  org = await User.create({ fullName: 'Rina Das', email: 'org@x.com', phone: '9000000001', role: Role.ORGANIZER, isActive: true, isEmailVerified: true, profile: { organizationName: 'Iconic Events' } });
  corp = await Category.create({ name: 'Corporate', isActive: true });
  const mk = (title: string, s: number, e: number) => Event.create({ organizerId: org._id, title, description: 'd', categoryId: corp._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(s), end: new Date(e) } });
  ev = await mk('Summit', Date.now() + day, Date.now() + 2 * day);
  past = await mk('Diwali Gala 2025', Date.now() - 5 * day, Date.now() - 4 * day);
});

describe('admin: guests, lists and the Preview List (items 14, 20, 22)', () => {
  it('adds a guest to an organizer\'s event, and the same person can be a system user of that organizer (item 14)', async () => {
    expect((await request(app).post(`/api/v1/events/${ev._id}/invitees`).set(auth(admin)).send({ name: 'Chanchal Roy', email: 'chanchal@x.com', mobile: '9876500077' })).status).toBe(201);
    const staff = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'Chanchal Roy', email: 'chanchal@x.com', phone: '9876500077', password: 'password123', role: 'SYSTEM_USER', organizerId: String(org._id) });
    expect(staff.status).toBe(201);
    expect(String((await User.findOne({ email: 'chanchal@x.com' }))!.createdBy)).toBe(String(org._id)); // belongs to the organizer, not to the admin
    // organizer is required when an admin adds staff
    const missing = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'No Owner', email: 'noowner@x.com', password: 'password123', role: 'SYSTEM_USER' });
    expect(missing.status).toBe(400); expect(missing.body.code).toBe('ORGANIZER_REQUIRED');
  });

  it('the Preview List: datasets include All, edit works after sending, delete sets an invited guest aside and a restore brings them back', async () => {
    const set: any = await InviteeSet.create({ eventId: ev._id, name: 'guests.xlsx', mode: 'APPEND' });
    const sent: any = await Invitee.create({ eventId: ev._id, inviteeSetId: set._id, name: 'Sayan', email: 'sayan@x.com', invitationStatus: InvitationStatus.SENT, rsvpStatus: RsvpStatus.ACCEPTED, qrTokenHash: 'a'.repeat(64), credentialVersion: 1, sessionAccess: [] });
    await Invitee.create({ eventId: ev._id, inviteeSetId: set._id, name: 'Idle Ida', email: 'ida@x.com', sessionAccess: [] });
    const sets = await request(app).get(`/api/v1/events/${ev._id}/invitees/sets`).set(auth(admin));
    expect(sets.status).toBe(200); expect(sets.body.data.sets.length).toBe(1);
    const all = await request(app).get(`/api/v1/events/${ev._id}/invitees/sets/all/members`).set(auth(admin));
    expect(all.status).toBe(200); expect(all.body.data.total).toBe(2);
    expect((await request(app).patch(`/api/v1/invitees/${sent._id}`).set(auth(admin)).send({ name: 'Sayan Ghosh' })).status).toBe(200);
    const del = await request(app).delete(`/api/v1/invitees/${sent._id}`).set(auth(admin));
    expect(del.status).toBe(200); expect(del.body.data.setAside).toBe(true);
    const kept: any = await Invitee.findOne({ _id: sent._id }).setOptions({ includeArchived: true } as any);
    expect(kept.archivedReason).toBe('REMOVED_BY_ORGANIZER'); expect(kept.credentialRevokedAt).toBeTruthy(); expect(kept.rsvpStatus).toBe(RsvpStatus.ACCEPTED);
    const aside = await request(app).get(`/api/v1/events/${ev._id}/invitees/set-aside`).set(auth(admin));
    expect(aside.body.data.guests.some((g: any) => g.name === 'Sayan Ghosh')).toBe(true);
    const back = await request(app).post(`/api/v1/events/${ev._id}/invitees/set-aside/restore`).set(auth(admin)).send({ inviteeIds: [String(sent._id)] });
    expect(back.status).toBe(200); expect(back.body.data.restored).toBe(1);
  });

  it('an Excel upload works for the admin, and a guest\'s address can be a system user\'s address', async () => {
    await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'Rina Staff', email: 'rina@x.com', phone: '9876500078', password: 'password123', role: 'SYSTEM_USER', organizerId: String(org._id) });
    const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['Name', 'Email', 'Mobile'], ['Rina Staff', 'rina@x.com', '9876500078'], ['Other', 'other@x.com', '9876500079']]), 'Invitees');
    const up = await request(app).post(`/api/v1/events/${ev._id}/invitees/import`).set(auth(admin)).field('mode', 'REPLACE').attach('file', xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'list.xlsx');
    expect(up.status).toBe(200);
    expect(await Invitee.countDocuments({ eventId: ev._id })).toBe(2);
  });
});

describe('admin: events (items 10, 11)', () => {
  it('the event list gives the admin every organizer\'s events, with dates that decide upcoming / ongoing / past', async () => {
    const res = await request(app).get('/api/v1/events').set(auth(admin));
    expect(res.status).toBe(200);
    const rows: any[] = res.body.data.events ?? res.body.data;
    const byTitle = Object.fromEntries(rows.map((e) => [e.title, e]));
    expect(new Date(byTitle['Summit'].schedule.start).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(byTitle['Diwali Gala 2025'].schedule.end).getTime()).toBeLessThan(Date.now());
  });
  it('an admin deletes a past event after typing its title; an upcoming one cannot be deleted, only cancelled', async () => {
    const wrong = await request(app).post(`/api/v1/events/${past._id}/delete`).set(auth(admin)).send({ confirmTitle: 'nope' });
    expect(wrong.status).toBeGreaterThanOrEqual(400); expect(await Event.findById(past._id)).not.toBeNull();
    const upcoming = await request(app).post(`/api/v1/events/${ev._id}/delete`).set(auth(admin)).send({ confirmTitle: 'Summit' });
    expect(upcoming.status).toBeGreaterThanOrEqual(400); expect(await Event.findById(ev._id)).not.toBeNull();
    const ok = await request(app).post(`/api/v1/events/${past._id}/delete`).set(auth(admin)).send({ confirmTitle: 'Diwali Gala 2025' });
    expect(ok.status).toBe(200); expect(await Event.findById(past._id)).toBeNull();
  });
});

describe('admin: invitation email and cards (items 7, 15)', () => {
  it('an admin sending an organizer\'s invitations uses the ORGANIZER\'s logo and name, never the admin\'s', async () => {
    const logo = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#123C8F' } }).png().toBuffer();
    const up = await request(app).post('/api/v1/media/upload').set(auth(org)).field('purpose', 'ORGANIZATION_LOGO').attach('file', logo, { filename: 'l.png', contentType: 'image/png' });
    await request(app).patch('/api/users/profile').set(auth(org)).send({ profile: { organizationName: 'Iconic Events', logoKey: up.body.data.key } });
    const g: any = await Invitee.create({ eventId: ev._id, name: 'Guest', email: 'guest@x.com', sessionAccess: [] });
    // the real route, as the admin's Send Invitation screen calls it
    const sent = await request(app).post(`/api/v1/events/${ev._id}/invitations/send`).set(auth(admin)).send({ inviteeIds: [String(g._id)], channel: 'EMAIL' });
    expect(sent.status).toBe(200);
    const [, , html, attachments] = mockSendEmail.mock.calls[0];
    expect(html).toContain(`src="cid:organizer-logo-${g._id}"`);
    expect(html).not.toContain('cid:lgpsm-logo');
    expect(html).toContain('Organized by <strong>Iconic Events</strong>');
    expect(attachments.some((a: any) => a.cid === `organizer-logo-${g._id}`)).toBe(true);
  });
  it('the card preview for an admin keeps its size with the QR on or off', async () => {
    const body = (qr: boolean) => ({ title: 'Summit', startIso: new Date(Date.now() + day).toISOString(), endIso: new Date(Date.now() + 2 * day).toISOString(), venue: 'Kolkata', cardDisplay: { qr } });
    const png = (qr: boolean) => request(app).post('/api/v1/templates/preview').set(auth(admin)).send(body(qr)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const [a, b] = [await png(true), await png(false)];
    expect([a.status, b.status]).toEqual([200, 200]);
    const [ma, mb] = [await sharp(a.body).metadata(), await sharp(b.body).metadata()];
    expect([mb.width, mb.height]).toEqual([ma.width, ma.height]);
  });
});

describe('admin: reports Action Log (items 24, 25)', () => {
  it('the audit trail an admin reads names who did what, with the organizer to resolve a name and ID from', async () => {
    await request(app).post(`/api/v1/events/${ev._id}/invitees`).set(auth(org)).send({ name: 'Logged Guest', email: 'logged@x.com' });
    await new Promise((r) => setTimeout(r, 400));
    const res = await request(app).get(`/api/v1/audit-logs?eventId=${ev._id}&limit=50`).set(auth(admin));
    expect(res.status).toBe(200);
    const rows: any[] = res.body.data;
    const row = rows.find((r) => r.action === 'INVITEE_CREATE');
    expect(row).toBeDefined();
    expect(String(row.organizerId?._id || row.organizerId)).toBe(String(org._id));
  });
});
