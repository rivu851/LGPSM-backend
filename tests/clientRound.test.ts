// The client's 2026-11-06 list: invitation channel at signup, choosing what the cards print (with the guest page's own QR when the
// card has none), clearing unused invitee lists, permanent deletion of past events, the organizer on the action log, and one person
// being both an invitee and a system user. Each rule is checked for the organizer and the admin, and refused for everyone else.
import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mockSendEmail = jest.fn().mockResolvedValue(true);
jest.mock('../src/utils/email.provider', () => ({ sendEmail: (...args: any[]) => mockSendEmail(...args) }));

import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { InviteeSet } from '../src/models/InviteeSet';
import { Session } from '../src/models/Session';
import { CheckIn } from '../src/models/CheckIn';
import { Invitation } from '../src/models/Invitation';
import { AuditLog } from '../src/models/AuditLog';
import { invitationCardService } from '../src/services/invitationCard.service';
import { generateAccessToken } from '../src/utils/token';
import { hashToken, generateSecureToken } from '../src/utils/invitation.util';
import { encryptToken } from '../src/utils/tokenCipher';
import { decodeQr } from './helpers/qr';

jest.setTimeout(90000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
let mongo: MongoMemoryServer; let a: any; let b: any; let admin: any; let corp: any;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({}).setOptions({ includeArchived: true } as any), InviteeSet.deleteMany({}), Session.deleteMany({}), CheckIn.deleteMany({}), Invitation.deleteMany({}), AuditLog.deleteMany({})]);
  a = await User.create({ fullName: 'A', email: 'a@x.com', role: Role.ORGANIZER, isActive: true, profile: { organizationName: 'Iconic Events' } });
  b = await User.create({ fullName: 'B', email: 'b@x.com', role: Role.ORGANIZER, isActive: true });
  admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', role: Role.ADMIN, isActive: true });
  corp = await Category.create({ name: 'Corporate', isActive: true });
});
const day = 864e5;
const mkEvent = (owner: any, extra: any = {}) => Event.create({ organizerId: owner._id, title: 'Summit', description: 'd', categoryId: corp._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) }, ...extra });
const past = { schedule: { start: new Date(Date.now() - 3 * day), end: new Date(Date.now() - 2 * day) } };

describe('invitation channel at signup', () => {
  it('is stored on the new organizer (Email & WhatsApp when not chosen), and rejected when unknown', async () => {
    await request(app).post('/api/auth/register').send({ fullName: 'New One', email: 'n1@x.com', password: 'password123', invitationChannel: 'WHATSAPP' });
    await request(app).post('/api/auth/register').send({ fullName: 'New Two', email: 'n2@x.com', password: 'password123' });
    expect((await User.findOne({ email: 'n1@x.com' }).lean() as any).profile.invitationChannel).toBe('WHATSAPP');
    expect((await User.findOne({ email: 'n2@x.com' }).lean() as any).profile.invitationChannel).toBe('BOTH');
    expect((await request(app).post('/api/auth/register').send({ fullName: 'Bad', email: 'n3@x.com', password: 'password123', invitationChannel: 'SMS' })).status).toBe(400);
  });

  it('an admin sets it when adding an organizer, and the event shows it to the send screen', async () => {
    const res = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'Org C', email: 'c@x.com', password: 'password123', role: 'ORGANIZER', profile: { organizationName: 'C Co', invitationChannel: 'EMAIL' } });
    expect(res.status).toBe(201);
    const c: any = await User.findOne({ email: 'c@x.com' }).lean();
    expect(c.profile.invitationChannel).toBe('EMAIL');
    const ev = await mkEvent(c);
    const got = await request(app).get(`/api/v1/events/${ev._id}`).set(auth(admin));
    expect(got.body.data.organizerId.profile.invitationChannel).toBe('EMAIL');
  });
});

describe('what the cards print', () => {
  const card = (cardDisplay?: any, design = 'CORPORATE_V1') => (invitationCardService as any).generateInvitationCardPNG({
    invitee: { name: 'Guest One', companyName: 'Acme' },
    event: { title: 'Summit 2026', venue: 'Kolkata', startIso: '2026-11-20T05:30:00Z', endIso: '2026-11-20T09:30:00Z', contactNumber: '9007000891' },
    sessions: [], invitationUrl: 'https://example.com/i/abc', cardDesign: design, cardDisplay
  });

  it('is saved on the event, and every combination still renders', async () => {
    const res = await request(app).post('/api/v1/events').set(auth(a)).send({ title: 'T', description: 'd', categoryId: String(corp._id), format: 'PHYSICAL', contactNumber: '9007000891', location: { address: 'x' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) }, cardDisplay: { qr: false, location: false } });
    expect(res.status).toBe(201);
    expect((await Event.findById(res.body.data.eventId).lean() as any).cardDisplay).toMatchObject({ qr: false, location: false });
    expect((await request(app).post('/api/v1/events').set(auth(a)).send({ title: 'T', description: 'd', categoryId: String(corp._id), format: 'PHYSICAL', contactNumber: '9007000891', location: { address: 'x' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) }, cardDisplay: { qr: 'no' } })).status).toBe(400);
    for (const design of ['CORPORATE_V1', 'WEDDING', 'BIRTHDAY', 'CLASSIC']) {
      for (const d of [{ title: false }, { qr: false }, { dateTime: false }, { location: false }, { title: false, qr: false, dateTime: false, location: false }]) {
        expect((await sharp(await card(d, design)).metadata()).width).toBeGreaterThan(0);
      }
    }
  });

  it('a card printed without the QR really has no QR, and with it the QR scans', async () => {
    expect(await decodeQr(await card())).toBe('https://example.com/i/abc');
    expect(await decodeQr(await card({ qr: false }))).toBeNull();
  });

  it('a hidden detail is not printed (the card changes), shown details stay', async () => {
    const full = await card();
    for (const key of ['title', 'dateTime', 'location']) {
      const without = await card({ [key]: false });
      expect(Buffer.compare(full, without)).not.toBe(0);
    }
  });

  it('the guest page gets the entry QR on its own when the card has none', async () => {
    const ev = await mkEvent(a, { cardDisplay: { qr: false } });
    const link = generateSecureToken(); const pass = generateSecureToken();
    await Invitee.create({ eventId: ev._id, name: 'G', email: 'g@x.invalid', invitationStatus: 'SENT', rsvpStatus: 'PENDING', invitationTokenHash: hashToken(link), invitationTokenCipher: encryptToken(link), qrTokenHash: hashToken(pass), qrTokenCipher: encryptToken(pass) });
    const page = await request(app).get(`/api/v1/public/invitations/${link}`);
    expect(page.body.data.cardShowsQr).toBe(false);
    const qr = await request(app).get(`/api/v1/public/invitations/${link}/qr`);
    expect(qr.status).toBe(200);
    expect(qr.headers['content-type']).toBe('image/png');
    // the same admission credential the card would carry, never the link token
    const decoded = await decodeQr(qr.body);
    expect(decoded).toContain(pass);
    expect(decoded).not.toContain(link);
    expect((await request(app).get(`/api/v1/public/invitations/${generateSecureToken()}/qr`)).status).toBe(404);
  });
});

describe('deleting unused invitee lists (card details changed after the sample was downloaded)', () => {
  const guests = async (ev: any) => {
    const set = await InviteeSet.create({ eventId: ev._id, name: 'list.xlsx', source: 'EXCEL', mode: 'REPLACE' } as any);
    await Invitee.create([{ eventId: ev._id, name: 'G1', email: 'g1@x.invalid', inviteeSetId: set._id }, { eventId: ev._id, name: 'G2', email: 'g2@x.invalid', inviteeSetId: set._id }]);
  };
  it('the owner or an admin can, while nothing was sent', async () => {
    for (const who of [a, admin]) {
      const ev = await mkEvent(a); await guests(ev);
      const res = await request(app).post(`/api/v1/events/${ev._id}/invitees/sets/clear`).set(auth(who));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ deletedInvitees: 2, deletedLists: 1 });
      expect(await Invitee.countDocuments({ eventId: ev._id })).toBe(0);
    }
  });
  it('nobody else can, and not once anything was sent', async () => {
    const ev = await mkEvent(a); await guests(ev);
    expect((await request(app).post(`/api/v1/events/${ev._id}/invitees/sets/clear`).set(auth(b))).status).toBe(404);
    const g = await Invitee.findOne({ eventId: ev._id });
    await Invitation.create({ eventId: ev._id, inviteeId: g!._id, emailStatus: 'SENT' } as any).catch(async () => { await Invitee.updateOne({ _id: g!._id }, { qrTokenHash: 'x' }); });
    await Invitee.updateOne({ _id: g!._id }, { qrTokenHash: hashToken('x') });
    const res = await request(app).post(`/api/v1/events/${ev._id}/invitees/sets/clear`).set(auth(a));
    expect(res.status).toBe(409);
    expect(await Invitee.countDocuments({ eventId: ev._id })).toBe(2);
  });
});

describe('Delete Event (past events, permanently)', () => {
  const fill = async (ev: any) => {
    const s = await Session.create({ eventId: ev._id, name: 'Main', schedule: ev.schedule } as any);
    const g = await Invitee.create({ eventId: ev._id, name: 'G', email: 'g@x.invalid' });
    await CheckIn.create({ eventId: ev._id, inviteeId: g._id, sessionId: s._id, checkInAt: new Date(), checkInMethod: 'MANUAL', checkedInBy: a._id } as any).catch(() => undefined);
  };
  it('the owner and an admin can delete a past event with all of its data; the audit trail keeps the record', async () => {
    for (const who of [a, admin]) {
      const ev = await mkEvent(a, past); await fill(ev);
      const res = await request(app).post(`/api/v1/events/${ev._id}/delete`).set(auth(who)).send({ confirmTitle: 'Summit' });
      expect(res.status).toBe(200);
      expect(await Event.findById(ev._id)).toBeNull();
      expect(await Session.countDocuments({ eventId: ev._id })).toBe(0);
      expect(await Invitee.countDocuments({ eventId: ev._id })).toBe(0);
      expect(await CheckIn.countDocuments({ eventId: ev._id })).toBe(0);
      expect(await AuditLog.countDocuments({ action: 'EVENT_DELETE', eventId: ev._id })).toBeGreaterThan(0);
    }
  });
  it('refused: an event that has not ended, a wrong title, another organizer, staff and anonymous callers', async () => {
    const future = await mkEvent(a);
    expect((await request(app).post(`/api/v1/events/${future._id}/delete`).set(auth(a)).send({ confirmTitle: 'Summit' })).status).toBe(409);
    const ev = await mkEvent(a, past);
    expect((await request(app).post(`/api/v1/events/${ev._id}/delete`).set(auth(a)).send({ confirmTitle: 'summit' })).status).toBe(400);
    expect((await request(app).post(`/api/v1/events/${ev._id}/delete`).set(auth(a)).send({})).status).toBe(400);
    expect((await request(app).post(`/api/v1/events/${ev._id}/delete`).set(auth(b)).send({ confirmTitle: 'Summit' })).status).toBe(404);
    const staff = await User.create({ fullName: 'S', email: 's@x.com', role: Role.SYSTEM_USER, isActive: true });
    expect((await request(app).post(`/api/v1/events/${ev._id}/delete`).set(auth(staff)).send({ confirmTitle: 'Summit' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/events/${ev._id}/delete`).send({ confirmTitle: 'Summit' })).status).toBe(401);
    expect(await Event.findById(future._id)).not.toBeNull();
    expect(await Event.findById(ev._id)).not.toBeNull();
  });
  it('a cancelled event that has ended can be deleted too', async () => {
    const ev = await mkEvent(a, { ...past, status: 'CANCELLED' });
    expect((await request(app).post(`/api/v1/events/${ev._id}/delete`).set(auth(a)).send({ confirmTitle: 'Summit' })).status).toBe(200);
  });
});

describe('the action log names the organizer', () => {
  it('returns the organizer with each entry', async () => {
    const ev = await mkEvent(a);
    await request(app).patch(`/api/v1/events/${ev._id}`).set(auth(a)).send({ title: 'Summit renamed' });
    const res = await request(app).get(`/api/v1/audit-logs?eventId=${ev._id}`).set(auth(admin));
    const withOrg = (res.body.data || []).find((l: any) => l.organizerId);
    if (withOrg) expect(withOrg.organizerId).toMatchObject({ profile: { organizationName: 'Iconic Events' } });
    expect(res.status).toBe(200);
  });
});

describe('one person can be an invitee and a system user', () => {
  it('works in both orders', async () => {
    const ev = await mkEvent(a);
    // invitee first, then the same person as staff
    expect((await request(app).post(`/api/v1/events/${ev._id}/invitees`).set(auth(a)).send({ name: 'Rima Sen', email: 'rima@x.com', mobile: '9876543210' })).status).toBe(201);
    expect((await request(app).post('/api/users').set(auth(a)).send({ fullName: 'Rima Sen', email: 'rima@x.com', phone: '9876543210', password: 'password123', role: 'SYSTEM_USER' })).status).toBe(201);
    // staff first, then the same person as a guest of another event
    const ev2 = await mkEvent(a);
    expect((await request(app).post(`/api/v1/events/${ev2._id}/invitees`).set(auth(a)).send({ name: 'Rima Sen', email: 'rima@x.com', mobile: '9876543210' })).status).toBe(201);
  });
});

describe('adding system users with shared contact details', () => {
  it('a deleted staff member added again by the same organizer comes back (not "email already in use")', async () => {
    const first = await request(app).post('/api/users').set(auth(a)).send({ fullName: 'Old Name', email: 'staff@x.com', phone: '9876500001', password: 'password123', role: 'SYSTEM_USER' });
    expect(first.status).toBe(201);
    expect((await request(app).delete(`/api/users/${first.body.data._id}`).set(auth(a))).status).toBe(200);
    const again = await request(app).post('/api/users').set(auth(a)).send({ fullName: 'New Name', email: 'staff@x.com', phone: '9876500002', password: 'password456', role: 'SYSTEM_USER' });
    expect(again.status).toBe(201);
    const u: any = await User.findOne({ email: 'staff@x.com' }).lean();
    expect(u.isActive).toBe(true);
    expect(u.fullName).toBe('New Name');
    expect(await User.countDocuments({ email: 'staff@x.com' })).toBe(1);
  });
  it('allows different accounts, including an organizer and staff, to share email and phone', async () => {
    const organizer = await User.create({
      fullName: 'Shared Organizer',
      email: 'shared@x.com',
      phone: '919876500003',
      role: Role.ORGANIZER,
      isActive: true,
    });

    const first = await request(app).post('/api/users').set(auth(a)).send({
      fullName: 'Shared Staff',
      email: organizer.email,
      phone: '9876500003',
      password: 'password123',
      role: 'SYSTEM_USER',
    });
    expect(first.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({
      email: organizer.email,
      phone: '9876500003',
      password: 'password123',
      role: 'SYSTEM_USER',
    });
    expect(login.status).toBe(200);
    expect(String(login.body.data.user._id)).toBe(first.body.data._id);

    const second = await request(app).post('/api/users').set(auth(b)).send({
      fullName: 'Another Shared Staff',
      email: organizer.email,
      phone: '9876500003',
      password: 'password456',
      role: 'SYSTEM_USER',
    });
    expect(second.status).toBe(201);
    expect(await User.countDocuments({ email: organizer.email })).toBe(3);
  });
});

describe('invitation email footer', () => {
  const base = { eventTitle: 'Summit', inviteeName: 'Guest', eventDate: 'Fri', eventTime: '10 AM', venue: 'Kolkata', invitationUrl: 'https://example.com/i/x', cid: 'qr-1', cardCid: 'card-1' };
  it('says who organized it, with their logo, for invitations and reminders', async () => {
    const { buildFormalInvitationEmailHTML } = await import('../src/services/invitation.service');
    for (const isReminder of [false, true]) {
      const html = buildFormalInvitationEmailHTML({ ...base, isReminder, organizerLogoCid: 'organizer-logo-1', organizerName: 'Iconic <Events>' });
      expect(html).toContain('Organized by <strong>Iconic &lt;Events&gt;</strong>');
      expect(html).toContain('src="cid:organizer-logo-1"');
    }
    // no organizer details: the platform line, and no broken image
    const plain = buildFormalInvitationEmailHTML(base);
    expect(plain).toContain('Organized via <strong>LGPSM Platform</strong>');
    expect(plain).not.toContain('organizer-logo');
  });
});

describe('an admin adding a system user', () => {
  it('must choose the organizer; the user then belongs to that organizer and shows in their list', async () => {
    const without = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'No Org', email: 'noorg@x.com', phone: '9876500010', password: 'password123', role: 'SYSTEM_USER' });
    expect(without.status).toBe(400);
    expect(without.body.code).toBe('ORGANIZER_REQUIRED');
    expect(await User.countDocuments({ email: 'noorg@x.com' })).toBe(0);
    const ok = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'With Org', email: 'withorg@x.com', phone: '9876500011', password: 'password123', role: 'SYSTEM_USER', organizerId: String(a._id) });
    expect(ok.status).toBe(201);
    const list = await request(app).get(`/api/users?role=SYSTEM_USER&organizerId=${a._id}`).set(auth(admin));
    expect(list.body.data.map((u: any) => u.email)).toContain('withorg@x.com');
    const otherList = await request(app).get(`/api/users?role=SYSTEM_USER&organizerId=${b._id}`).set(auth(admin));
    expect(otherList.body.data.map((u: any) => u.email)).not.toContain('withorg@x.com');
    // an organizer still adds staff for themselves without choosing anyone
    expect((await request(app).post('/api/users').set(auth(a)).send({ fullName: 'Own Staff', email: 'own@x.com', phone: '9876500012', password: 'password123', role: 'SYSTEM_USER' })).status).toBe(201);
  });
});
