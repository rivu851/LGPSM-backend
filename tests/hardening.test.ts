import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as xlsx from 'xlsx';
import bcrypt from 'bcrypt';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Session } from '../src/models/Session';
import { Invitee } from '../src/models/Invitee';
import { Invitation } from '../src/models/Invitation';
import { CheckIn } from '../src/models/CheckIn';
import { RefreshToken } from '../src/models/RefreshToken';
import { PasswordResetOtp } from '../src/models/PasswordResetOtp';
import { PasswordResetThrottle } from '../src/models/PasswordResetThrottle';
import zlib from 'zlib';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { CredentialEvent } from '../src/models/CredentialEvent';
import { CancellationNotice } from '../src/models/CancellationNotice';
import { InviteeSet } from '../src/models/InviteeSet';
import * as emailProvider from '../src/utils/email.provider';
import { generateAccessToken } from '../src/utils/token';
import { isPrivateAddress } from '../src/utils/safeFetch';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

// Regression tests from the production-readiness audit. Each block names the defect it pins down; every assertion reads the
// database or the HTTP response, never a mock's return value.
jest.setTimeout(120_000);

const HOUR = 3600e3;
const PASSWORD = 'AuditPass123!';

describe('production hardening', () => {
  let mongo: MongoMemoryServer;
  let organizer: any, otherOrganizer: any, admin: any, staff: any;
  let tOrg = '', tOther = '', tAdmin = '', tStaff = '';
  const mails: { to: string; subject: string; html: string }[] = [];
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sheet = (rows: (string | number)[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'I'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };

  const mkEvent = (over: Record<string, unknown> = {}) => Event.create({
    organizerId: organizer._id, title: 'Audit Event', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL',
    location: { address: 'Hall' }, schedule: { start: new Date(Date.now() - HOUR), end: new Date(Date.now() + 4 * HOUR) }, status: 'PUBLISHED', ...over,
  });
  let seq = 0;
  const mkGuest = (eventId: unknown, over: Record<string, unknown> = {}) => { seq++; return Invitee.create({ eventId, name: `Guest ${seq}`, email: `g${seq}@guest.test`, ...over }); };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([Invitee, CheckIn, User, RefreshToken, PasswordResetThrottle].map((m: any) => m.syncIndexes()));
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const mk = (fullName: string, email: string, role: Role, extra = {}) => User.create({ fullName, email, passwordHash, role, isActive: true, isEmailVerified: true, ...extra });
    organizer = await mk('Org One', 'org1@x.test', Role.ORGANIZER);
    otherOrganizer = await mk('Org Two', 'org2@x.test', Role.ORGANIZER);
    admin = await mk('Admin', 'admin@x.test', Role.ADMIN);
    staff = await mk('Staff', 'staff@x.test', Role.SYSTEM_USER, { createdBy: organizer._id });
    tOrg = generateAccessToken(String(organizer._id), Role.ORGANIZER);
    tOther = generateAccessToken(String(otherOrganizer._id), Role.ORGANIZER);
    tAdmin = generateAccessToken(String(admin._id), Role.ADMIN);
    tStaff = generateAccessToken(String(staff._id), Role.SYSTEM_USER);
  });
  beforeEach(() => {
    mails.length = 0;
    jest.spyOn(emailProvider, 'sendEmail').mockImplementation((async (to: string, subject: string, html: string) => { mails.push({ to, subject, html }); return true; }) as any);
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  describe('H1 guest records: only the guest-detail fields can be written through the API', () => {
    it('create ignores credential, delivery, RSVP and archive fields in the body', async () => {
      const ev = await mkEvent();
      const res = await request(app).post(`/api/v1/events/${ev._id}/invitees`).set(auth(tOrg)).send({
        name: 'Mallory', email: 'mallory@guest.test', qrTokenHash: 'a'.repeat(64), invitationTokenHash: 'b'.repeat(64), invitationStatus: 'SENT', rsvpStatus: 'ACCEPTED',
        credentialVersion: 9, archivedAt: new Date().toISOString(), inviteeSetId: new mongoose.Types.ObjectId().toString(), restoredBy: String(admin._id),
      });
      expect(res.status).toBe(201);
      const g: any = await Invitee.findById(res.body.data._id).setOptions({ includeArchived: true } as any).lean();
      expect(g.qrTokenHash).toBeUndefined();
      expect(g.invitationTokenHash).toBeUndefined();
      expect(g.invitationStatus).toBe('PENDING');
      expect(g.rsvpStatus).toBe('PENDING');
      expect(g.credentialVersion).toBeUndefined();
      expect(g.archivedAt).toBeNull();
      expect(g.inviteeSetId).toBeNull();
    });

    it('update cannot lift a revocation or plant a credential', async () => {
      const ev = await mkEvent();
      const revokedAt = new Date();
      const g = await mkGuest(ev._id, { qrTokenHash: 'c'.repeat(64), credentialRevokedAt: revokedAt, credentialRevocation: { category: 'ACCESS_WITHDRAWN', at: revokedAt } });
      const res = await request(app).patch(`/api/v1/invitees/${g._id}`).set(auth(tOrg)).send({ name: 'New Name', credentialRevokedAt: null, credentialRevocation: null, qrTokenHash: 'd'.repeat(64), archivedAt: new Date().toISOString() });
      expect(res.status).toBe(200);
      const after: any = await Invitee.findById(g._id).lean();
      expect(after.name).toBe('New Name');
      expect(after.credentialRevokedAt).not.toBeNull();
      expect(after.credentialRevocation?.category).toBe('ACCESS_WITHDRAWN');
      expect(after.qrTokenHash).toBe('c'.repeat(64));
      expect(after.archivedAt).toBeNull();
    });

    it('session access on a guest can only name sessions of that event', async () => {
      const ev = await mkEvent(); const other = await mkEvent();
      const foreign = await Session.create({ eventId: other._id, name: 'Foreign', schedule: other.schedule });
      const res = await request(app).post(`/api/v1/events/${ev._id}/invitees`).set(auth(tOrg)).send({ name: 'X Guest', email: 'x1@guest.test', sessionAccess: [{ sessionId: String(foreign._id), allowed: true }] });
      expect(res.status).toBe(400);
    });
  });

  describe('H2 a closed or cancelled event is a historical record', () => {
    const terminal = [['COMPLETED', { status: 'COMPLETED', closedAt: new Date() }], ['CANCELLED', { status: 'CANCELLED', cancelledAt: new Date() }]] as const;
    it.each(terminal)('%s: guests, sessions and staff cannot be changed', async (_n, state) => {
      const ev = await mkEvent(state as any);
      const g = await mkGuest(ev._id);
      const s = await Session.create({ eventId: ev._id, name: 'S1', schedule: ev.schedule });
      const a = await SystemUserAssignment.create({ userId: staff._id, eventId: ev._id, sessionIds: [], assignedBy: organizer._id });
      const b = auth(tOrg);
      const when = { start: new Date(ev.schedule.start).toISOString(), end: new Date(ev.schedule.end).toISOString() };
      const attempts: [string, request.Test][] = [
        ['add guest', request(app).post(`/api/v1/events/${ev._id}/invitees`).set(b).send({ name: 'Late Guest', email: 'late@guest.test' })],
        ['edit guest', request(app).patch(`/api/v1/invitees/${g._id}`).set(b).send({ name: 'Changed' })],
        ['delete guest', request(app).delete(`/api/v1/invitees/${g._id}`).set(b)],
        ['guest session access', request(app).put(`/api/v1/invitees/${g._id}/session-access`).set(b).send({ sessionAccess: [{ sessionId: String(s._id), allowed: false }] })],
        ['bulk session access', request(app).put(`/api/v1/events/${ev._id}/invitees/session-access/bulk`).set(b).send({ inviteeIds: [String(g._id)], sessionAccess: [{ sessionId: String(s._id), allowed: false }] })],
        ['import', request(app).post(`/api/v1/events/${ev._id}/invitees/import`).set(b).field('mode', 'APPEND').attach('file', sheet([['Name', 'Email'], ['New One', 'n1@guest.test']]), 'g.xlsx')],
        ['create session', request(app).post(`/api/v1/events/${ev._id}/sessions`).set(b).send({ name: 'S2', schedule: when })],
        ['edit session', request(app).patch(`/api/v1/sessions/${s._id}`).set(b).send({ name: 'Renamed' })],
        ['delete session', request(app).delete(`/api/v1/sessions/${s._id}`).set(b)],
        ['assign staff', request(app).post(`/api/v1/events/${ev._id}/assignments`).set(b).send({ userId: String(new mongoose.Types.ObjectId()), sessionIds: [] })],
        ['edit assignment', request(app).patch(`/api/v1/assignments/${a._id}`).set(b).send({ sessionIds: [String(s._id)] })],
        ['remove assignment', request(app).delete(`/api/v1/assignments/${a._id}`).set(b)],
      ];
      const failures: string[] = [];
      for (const [name, attempt] of attempts) { const r = await attempt; if (r.status !== 409) failures.push(`${name}: ${r.status}`); }
      expect(failures).toEqual([]);
      const stored: any = await Invitee.findById(g._id).lean();
      expect(stored.name).toBe(g.name);
      expect(await Session.countDocuments({ eventId: ev._id })).toBe(1);
      expect(await SystemUserAssignment.countDocuments({ eventId: ev._id })).toBe(1);
      expect(await Invitee.countDocuments({ eventId: ev._id })).toBe(1);
    });

    it('sending and re-sending are refused once an event is closed or has ended', async () => {
      const closed = await mkEvent({ status: 'COMPLETED', closedAt: new Date() });
      const g1 = await mkGuest(closed._id);
      const r1 = await request(app).post(`/api/v1/events/${closed._id}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: [String(g1._id)], channel: 'EMAIL' });
      expect(r1.status).toBe(409);
      const ended = await mkEvent({ schedule: { start: new Date(Date.now() - 5 * HOUR), end: new Date(Date.now() - HOUR) } });
      const g2 = await mkGuest(ended._id);
      const r2 = await request(app).post(`/api/v1/events/${ended._id}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: [String(g2._id)], channel: 'EMAIL' });
      expect(r2.status).toBe(409);
      const inv = await Invitation.create({ eventId: closed._id, inviteeId: g1._id, channel: 'EMAIL', status: 'SENT', tokenHash: 'e'.repeat(64) });
      const r3 = await request(app).post(`/api/v1/events/${closed._id}/invitations/resend`).set(auth(tOrg)).send({ invitationIds: [String(inv._id)] });
      expect(r3.status).toBe(409);
      expect(mails).toHaveLength(0);
    });

    it('an RSVP or food answer is refused once the event was closed, even before its deadline', async () => {
      const raw = generateSecureToken();
      const ev = await mkEvent({ status: 'COMPLETED', closedAt: new Date(), rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: false, allowDeclined: false, acceptanceLastDate: new Date(Date.now() + 24 * HOUR) } });
      const g = await mkGuest(ev._id, { invitationTokenHash: hashToken(raw), qrTokenHash: hashToken(generateSecureToken()) });
      const r = await request(app).post(`/api/v1/public/invitations/${raw}/rsvp`).send({ rsvpStatus: 'ACCEPTED' });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(((await Invitee.findById(g._id).lean()) as any).rsvpStatus).toBe('PENDING');
      const raw2 = generateSecureToken();
      const ev2 = await mkEvent({ status: 'COMPLETED', closedAt: new Date(), rsvp: { enabled: false, allowAllInvited: true, allowNotResponded: false, allowDeclined: false }, dietaryPreference: { enabled: true, title: 'Food', options: ['Veg'] } });
      await mkGuest(ev2._id, { invitationTokenHash: hashToken(raw2), qrTokenHash: hashToken(generateSecureToken()) });
      const f = await request(app).post(`/api/v1/public/invitations/${raw2}/food`).send({ dietarySelections: [{ title: 'Food', value: 'Veg' }] });
      expect(f.status).toBeGreaterThanOrEqual(400);
    });

    it('a guest cannot move their own RSVP back to PENDING', async () => {
      const raw = generateSecureToken();
      const ev = await mkEvent({ rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: false, allowDeclined: false } });
      await mkGuest(ev._id, { invitationTokenHash: hashToken(raw), qrTokenHash: hashToken(generateSecureToken()), rsvpStatus: 'ACCEPTED' });
      const r = await request(app).post(`/api/v1/public/invitations/${raw}/rsvp`).send({ rsvpStatus: 'PENDING' });
      expect(r.status).toBe(400);
    });
  });

  describe('H3 attendance history survives session changes', () => {
    it('a session with recorded attendance cannot be deleted', async () => {
      const ev = await mkEvent(); const g = await mkGuest(ev._id);
      const s = await Session.create({ eventId: ev._id, name: 'Keep', schedule: ev.schedule });
      await CheckIn.create({ eventId: ev._id, inviteeId: g._id, sessionId: s._id, checkInMethod: 'QR', checkedInBy: staff._id, checkInAt: new Date() });
      const r = await request(app).delete(`/api/v1/sessions/${s._id}`).set(auth(tOrg));
      expect(r.status).toBe(409);
      expect(await Session.exists({ _id: s._id })).toBeTruthy();
    });

    it.each(['create', 'update'])('session %s refuses a check-in window that closes before it opens', async (mode) => {
      const ev = await mkEvent();
      const start = new Date(ev.schedule.start).toISOString(), end = new Date(ev.schedule.end).toISOString();
      const admission = { opensAt: end, closesAt: start };
      const r = mode === 'create'
        ? await request(app).post(`/api/v1/events/${ev._id}/sessions`).set(auth(tOrg)).send({ name: 'Bad', schedule: { start, end }, admission })
        : await request(app).patch(`/api/v1/sessions/${(await Session.create({ eventId: ev._id, name: 'Ok', schedule: ev.schedule }))._id}`).set(auth(tOrg)).send({ admission });
      expect(r.status).toBe(400);
    });
  });

  describe('H4 event input', () => {
    const base = () => ({ title: 'T', description: 'D', format: 'PHYSICAL', location: { address: 'Hall' } });
    it('refuses an event that ends before it starts, or has unreadable dates', async () => {
      const s = new Date(Date.now() + 5 * HOUR).toISOString(), e = new Date(Date.now() + HOUR).toISOString();
      expect((await request(app).post('/api/v1/events').set(auth(tOrg)).send({ ...base(), schedule: { start: s, end: e } })).status).toBe(400);
      expect((await request(app).post('/api/v1/events').set(auth(tOrg)).send({ ...base(), schedule: { start: 'not-a-date', end: e } })).status).toBe(400);
    });
    it('an admin creating an event for an organizer must name a real, active organizer', async () => {
      const s = new Date(Date.now() + HOUR).toISOString(), e = new Date(Date.now() + 5 * HOUR).toISOString();
      const body = { ...base(), schedule: { start: s, end: e } };
      expect((await request(app).post('/api/v1/events').set(auth(tAdmin)).send({ ...body, organizerId: 'garbage' })).status).toBe(400);
      expect((await request(app).post('/api/v1/events').set(auth(tAdmin)).send({ ...body, organizerIds: [String(staff._id)] })).status).toBe(400);
      expect((await request(app).post('/api/v1/events').set(auth(tAdmin)).send({ ...body, organizerIds: [String(new mongoose.Types.ObjectId())] })).status).toBe(400);
      expect((await request(app).post('/api/v1/events').set(auth(tAdmin)).send({ ...body, organizerIds: [String(organizer._id)] })).status).toBe(201);
    });
    it('list parameters are bounded and malformed values never produce a 500', async () => {
      const ev = await mkEvent();
      const page = await request(app).get('/api/v1/events?limit=100000&page=-3').set(auth(tOrg));
      expect(page.status).toBe(200);
      expect(page.body.meta.limit).toBeLessThanOrEqual(200);
      expect((await request(app).get('/api/v1/events?status=A&status=B').set(auth(tOrg))).status).toBeLessThan(500);
      expect((await request(app).get(`/api/v1/events/${ev._id}/invitees?search=a&search=b`).set(auth(tOrg))).status).toBe(200);
      expect((await request(app).get(`/api/v1/events/${ev._id}/invitees?rsvpStatus=A&rsvpStatus=B`).set(auth(tOrg))).status).toBeLessThan(500);
      expect((await request(app).get(`/api/v1/events/${ev._id}/invitees?sessionId=garbage`).set(auth(tOrg))).status).toBeLessThan(500);
      expect((await request(app).get(`/api/v1/events/${ev._id}/invitees?sessionAccessId=garbage`).set(auth(tOrg))).status).toBeLessThan(500);
      expect((await request(app).get('/api/users?search=a&search=b').set(auth(tOrg))).status).toBeLessThan(500);
      const inv = await request(app).get(`/api/v1/events/${ev._id}/invitations?limit=100000&page=-1`).set(auth(tOrg));
      expect(inv.status).toBe(200);
      const chk = await request(app).get(`/api/v1/events/${ev._id}/checkins?limit=1000000`).set(auth(tOrg));
      expect(chk.status).toBe(200);
      expect(chk.body.meta.limit).toBeLessThanOrEqual(1000);
      const notes = await request(app).get('/api/v1/notifications?limit=100000&page=-1').set(auth(tOrg));
      expect(notes.status).toBe(200);
      expect((await request(app).get('/api/v1/reports/earnings?eventId=garbage').set(auth(tOrg))).status).toBeLessThan(500);
    });
  });

  describe('H5 sign-in sessions', () => {
    const login = async () => (await request(app).post('/api/auth/login').send({ email: 'org1@x.test', password: PASSWORD })).body.data;
    it('a refresh token can be exchanged once, even by simultaneous requests', async () => {
      const { refreshToken } = await login();
      const results = await Promise.all(Array.from({ length: 6 }, () => request(app).post('/api/auth/refresh').send({ refreshToken })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    });
    it('re-using an already exchanged token ends every session of that account', async () => {
      const { refreshToken } = await login();
      const rotated = await request(app).post('/api/auth/refresh').send({ refreshToken });
      expect(rotated.status).toBe(200);
      // a retry moments later (two tabs, a lost response) is refused but ends nothing
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken })).status).toBe(401);
      const stillValid = rotated.body.data.refreshToken;
      const second = await request(app).post('/api/auth/refresh').send({ refreshToken: stillValid });
      expect(second.status).toBe(200);
      // the same token coming back later means two parties hold it
      await RefreshToken.updateOne({ token: hashToken(stillValid) }, { $set: { rotatedAt: new Date(Date.now() - 5 * 60e3) } });
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken: stillValid })).status).toBe(401);
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken: second.body.data.refreshToken })).status).toBe(401);
    });
    it('a query operator in the logout body cannot end someone else’s session', async () => {
      const { refreshToken } = await login();
      for (const body of [{ refreshToken: { $ne: null } }, { refreshToken: { $gt: '' } }, { refreshToken: ['x'] }]) {
        expect((await request(app).post('/api/auth/logout').send(body)).status).toBe(200);
      }
      expect(await RefreshToken.countDocuments({ token: hashToken(refreshToken), isRevoked: true })).toBe(0);
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken })).status).toBe(200);
    });
    it('refresh tokens are not stored in a usable form', async () => {
      const { refreshToken } = await login();
      expect(await RefreshToken.findOne({ token: refreshToken }).lean()).toBeNull();
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken })).status).toBe(200);
    });
    it('a token stored in the old plain form still works once, so a deploy signs nobody out', async () => {
      const { refreshToken } = await login();
      await RefreshToken.updateOne({ token: hashToken(refreshToken) }, { $set: { token: refreshToken } });
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken })).status).toBe(200);
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken })).status).toBe(401);
    });
    it('logout ends the session', async () => {
      const { refreshToken } = await login();
      expect((await request(app).post('/api/auth/logout').send({ refreshToken })).status).toBe(200);
      expect((await request(app).post('/api/auth/refresh').send({ refreshToken })).status).toBe(401);
    });
    it('an unknown account costs the same password check as a known one', async () => {
      const spy = jest.spyOn(bcrypt, 'compare');
      await request(app).post('/api/auth/login').send({ email: 'nobody@x.test', password: PASSWORD });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('H6 password reset codes', () => {
    const email = 'org2@x.test';
    const request4 = () => request(app).post('/api/auth/forgot-password/otp').send({ email });
    const guess = (code: string) => request(app).post('/api/auth/forgot-password/verify-otp').send({ email, code });
    const wrong = async () => { const rec: any = await PasswordResetOtp.findOne({ email }); for (let i = 0; i < 10000; i++) { const c = String(i).padStart(4, '0'); if (!(await bcrypt.compare(c, rec.codeHash))) return c; } return '0000'; };
    beforeEach(async () => { await PasswordResetOtp.deleteMany({ email }); await PasswordResetThrottle.deleteMany({ email }); });
    const ageLastSent = () => PasswordResetOtp.updateOne({ email }, { $set: { lastSentAt: new Date(Date.now() - 60_000) } });

    it('simultaneous guesses cannot exceed the attempt limit', async () => {
      await request4();
      const bad = await wrong();
      await Promise.all(Array.from({ length: 12 }, () => guess(bad)));
      const rec: any = await PasswordResetOtp.findOne({ email }).lean();
      expect(rec.attempts).toBe(5); // the sixth to twelfth were refused without being checked
      const spy = jest.spyOn(bcrypt, 'compare');
      await Promise.all(Array.from({ length: 6 }, () => guess(bad)));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
    it('new codes cannot buy unlimited guesses: an account has ten per day, from any address', async () => {
      await request4();
      for (let round = 0; round < 3; round++) {
        const bad = await wrong();
        for (let i = 0; i < 5; i++) await guess(bad);
        await ageLastSent();
        await request4();
      }
      const rec: any = await PasswordResetThrottle.findOne({ email }).lean();
      expect(rec.failedGuesses).toBeLessThanOrEqual(11);
      const spy = jest.spyOn(bcrypt, 'compare');
      await guess('0000');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
    it('the right code still works within the allowance, and clears the count', async () => {
      await request4();
      const code = '1234';
      await PasswordResetOtp.updateOne({ email }, { codeHash: await bcrypt.hash(code, 4) });
      await guess('9999');
      const ok = await guess(code);
      expect(ok.status).toBe(200);
      expect(ok.body.data.resetToken).toBeTruthy();
      expect(await PasswordResetThrottle.exists({ email, failedGuesses: { $gt: 0 } })).toBeNull();
    });
    it('one address cannot be sent unlimited codes', async () => {
      for (let i = 0; i < 14; i++) { await request4(); await ageLastSent(); }
      expect(mails.filter((m) => m.to === email).length).toBeLessThanOrEqual(10);
    });
  });

  describe('H7 outgoing mail never carries markup from user-entered text', () => {
    const evil = '<img src=x onerror=alert(1)><a href="https://evil.test">Claim</a>';
    it('the invitation email escapes the event title, guest name and venue', async () => {
      const ev = await mkEvent({ title: `Gala ${evil}`.slice(0, 100), location: { address: `Hall ${evil}` } });
      const g = await mkGuest(ev._id, { name: 'Ann <b>Bold</b>' });
      const r = await request(app).post(`/api/v1/events/${ev._id}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: [String(g._id)], channel: 'EMAIL' });
      expect(r.status).toBe(200);
      const html = mails.find((m) => m.to === g.email)!.html;
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<b>Bold</b>');
      expect(html).not.toContain('href="https://evil.test"');
      expect(html).toContain('&lt;b&gt;Bold&lt;/b&gt;');
    });
    it('account emails escape the person’s name', async () => {
      await request(app).post('/api/auth/register').send({ fullName: `Eve ${evil}`, email: 'eve.reg@x.test', password: PASSWORD });
      await request(app).post('/api/auth/forgot-password').send({ email: 'org1@x.test' });
      await User.updateOne({ email: 'org1@x.test' }, { fullName: 'Org <i>One</i>' });
      await request(app).post('/api/auth/forgot-password').send({ email: 'org1@x.test' });
      await request(app).post('/api/auth/forgot-password/otp').send({ email: 'org1@x.test' });
      await request(app).post('/api/users').set(auth(tAdmin)).send({ fullName: `Sam ${evil}`, email: 'sam.new@x.test', role: 'SYSTEM_USER' });
      await User.updateOne({ email: 'org1@x.test' }, { fullName: 'Org One' });
      for (const m of mails) { expect(m.html).not.toContain('<img src=x'); expect(m.html).not.toContain('<i>One</i>'); }
      expect(mails.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('H8 one pass at a time', () => {
    it('two simultaneous sends deliver once', async () => {
      const ev = await mkEvent(); const g = await mkGuest(ev._id);
      const results = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/v1/events/${ev._id}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: [String(g._id)], channel: 'EMAIL' })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(mails.filter((m) => m.to === g.email)).toHaveLength(1);
    });
    it('two simultaneous re-sends deliver once and the delivered pass is the valid one', async () => {
      const ev = await mkEvent(); const g = await mkGuest(ev._id);
      await request(app).post(`/api/v1/events/${ev._id}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: [String(g._id)], channel: 'EMAIL' });
      const inv: any = await Invitation.findOne({ eventId: ev._id, inviteeId: g._id });
      mails.length = 0;
      const results = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/v1/events/${ev._id}/invitations/resend`).set(auth(tOrg)).send({ invitationIds: [String(inv._id)] })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(mails.filter((m) => m.to === g.email)).toHaveLength(1);
      expect(results.flatMap((r) => r.body.results).filter((o: any) => o.status === 'SENT')).toHaveLength(1);
    });
    it('a claim left by a crashed process does not block the guest for ever', async () => {
      const ev = await mkEvent(); const g = await mkGuest(ev._id);
      await Invitee.updateOne({ _id: g._id }, { $set: { sendClaimAt: new Date(Date.now() - 60 * 60e3) } });
      await request(app).post(`/api/v1/events/${ev._id}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: [String(g._id)], channel: 'EMAIL' });
      expect(mails.filter((m) => m.to === g.email)).toHaveLength(1);
      expect(((await Invitee.findById(g._id).lean()) as any).sendClaimAt ?? null).toBeNull();
    });
  });

  describe('H9 spreadsheet uploads', () => {
    const up = (ev: any, buf: Buffer, name = 'g.xlsx', type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') => request(app).post(`/api/v1/events/${ev._id}/invitees/import`).set(auth(tOrg)).field('mode', 'APPEND').attach('file', buf, { filename: name, contentType: type });
    it('a real workbook still imports', async () => {
      const ev = await mkEvent();
      const r = await up(ev, sheet([['Name', 'Email'], ['Real One', 'real1@guest.test']]));
      expect(r.status).toBe(200);
      expect(r.body.data.imported).toBe(1);
    });
    it('a file that is not a workbook is refused whatever it claims to be', async () => {
      const ev = await mkEvent();
      const html = Buffer.from('<html><body><table><tr><td>Name</td><td>Email</td></tr><tr><td>Sneaky</td><td>s@guest.test</td></tr></table></body></html>');
      expect((await up(ev, html)).status).toBe(400);
      expect((await up(ev, Buffer.from('Name,Email\nSneaky,s@guest.test\n'))).status).toBe(400);
      expect(await Invitee.countDocuments({ eventId: ev._id })).toBe(0);
    });
    it('a workbook that inflates beyond the limit is refused before it is parsed', async () => {
      const ev = await mkEvent();
      const r = await up(ev, buildZip(200 * 1024 * 1024, Buffer.from([3, 0])));
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/too large/i);
    });
    it('a workbook that lies about its size is stopped while inflating', async () => {
      const ev = await mkEvent();
      const compressed = zlib.deflateRawSync(Buffer.alloc(120 * 1024 * 1024));
      const r = await up(ev, buildZip(1000, compressed));
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/too large/i);
      expect(await Invitee.countDocuments({ eventId: ev._id })).toBe(0);
    });
  });

  describe('H10 server-side image fetches', () => {
    it.each(['::ffff:7f00:1', '::ffff:0a00:0001', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '2002:7f00:1::', 'fec0::1', '64:ff9b:1::1', '::ffff:127.0.0.1', '::1', 'fe80::1'])('%s is treated as private', (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    });
    it.each(['8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808'])('%s stays allowed', (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    });
  });

  describe('H11 staff accounts across organizers', () => {
    it('an organizer cannot reset the password of staff another organizer created', async () => {
      const foreign = await User.create({ fullName: 'Foreign Staff', email: 'foreign.staff@x.test', role: Role.SYSTEM_USER, createdBy: otherOrganizer._id, isActive: true, passwordHash: 'x' });
      const ev = await mkEvent();
      await SystemUserAssignment.create({ userId: foreign._id, eventId: ev._id, sessionIds: [], assignedBy: admin._id });
      const r = await request(app).patch(`/api/users/${foreign._id}`).set(auth(tOrg)).send({ password: 'Hijacked123!' });
      expect(r.status).toBe(403);
      expect(((await User.findById(foreign._id).lean()) as any).passwordHash).toBe('x');
      expect((await request(app).patch(`/api/users/${foreign._id}`).set(auth(tOrg)).send({ email: 'stolen@x.test' })).status).toBe(403);
      expect((await request(app).delete(`/api/users/${foreign._id}`).set(auth(tOrg))).status).toBe(403);
      // they can still see who works their event
      expect((await request(app).get(`/api/users/${foreign._id}`).set(auth(tOrg))).status).toBe(200);
    });
    it('an organizer still manages staff they created', async () => {
      const own = await User.create({ fullName: 'Own Staff', email: 'own.staff@x.test', role: Role.SYSTEM_USER, createdBy: organizer._id, isActive: true, passwordHash: 'x' });
      expect((await request(app).patch(`/api/users/${own._id}`).set(auth(tOrg)).send({ fullName: 'Own Staff Two' })).status).toBe(200);
    });
    it('a second account cannot take a phone number another account signs in with', async () => {
      await User.updateOne({ _id: staff._id }, { phone: '919876500001' });
      const r = await request(app).post('/api/users').set(auth(tOther)).send({ fullName: 'Copy Cat', email: 'copy.cat@x.test', phone: '9876500001', role: 'SYSTEM_USER', password: PASSWORD });
      expect(r.status).toBe(409);
      expect((await request(app).post('/api/auth/login').send({ phone: '9876500001', password: PASSWORD })).status).toBe(200);
      await User.updateOne({ _id: staff._id }, { $unset: { phone: '' } });
    });
    it('the last active administrator cannot be deactivated', async () => {
      const r = await request(app).delete(`/api/users/${admin._id}`).set(auth(tAdmin));
      expect(r.status).toBe(409);
      const p = await request(app).patch(`/api/users/${admin._id}`).set(auth(tAdmin)).send({ isActive: false });
      expect(p.status).toBe(409);
      expect(((await User.findById(admin._id).lean()) as any).isActive).toBe(true);
    });
    it('staff read only their own assignment sessions and cannot read a list limit beyond the cap', async () => {
      const ev = await mkEvent();
      await SystemUserAssignment.create({ userId: staff._id, eventId: ev._id, sessionIds: [], assignedBy: organizer._id });
      const r = await request(app).get(`/api/v1/events/${ev._id}/checkins?limit=999999`).set(auth(tStaff));
      expect(r.status).toBe(200);
      expect(r.body.meta.limit).toBeLessThanOrEqual(1000);
    });
    it('profile details and organization can be saved together', async () => {
      const r = await request(app).patch('/api/users/profile').set(auth(tOrg)).send({ fullName: 'Org One', profile: { avatarKey: 'media:abc' }, organization: { name: 'Acme' } });
      expect(r.status).toBe(200);
      const u: any = await User.findById(organizer._id).lean();
      expect(u.profile.organizationName).toBe('Acme');
      expect(u.profile.avatarKey).toBe('media:abc');
    });
  });

  describe('H12 credential encryption key', () => {
    afterEach(() => { delete process.env.QR_TOKEN_SECRET; });
    it('tokens stored before QR_TOKEN_SECRET was set stay readable afterwards; new ones use the dedicated key', async () => {
      const { encryptToken, decryptToken } = await import('../src/utils/tokenCipher');
      const before = encryptToken('legacy-token');
      process.env.QR_TOKEN_SECRET = 'a-dedicated-secret-for-tests-only-0000000000';
      expect(decryptToken(before)).toBe('legacy-token');
      const after = encryptToken('new-token');
      expect(decryptToken(after)).toBe('new-token');
      delete process.env.QR_TOKEN_SECRET;
      expect(decryptToken(after)).toBeNull();
    });
  });

  describe('H13 permanent deletion', () => {
    it('removes everything personal about the event and keeps the event record and audit trail', async () => {
      const ev = await mkEvent({ status: 'COMPLETED', closedAt: new Date() });
      const g = await mkGuest(ev._id);
      await CredentialEvent.create({ eventId: ev._id, inviteeId: g._id, organizerId: organizer._id, type: 'ISSUED', version: 1, source: 'SEND', tokenHash: 'a'.repeat(64) });
      await CancellationNotice.create({ eventId: ev._id, inviteeId: g._id, organizerId: organizer._id, email: { status: 'NOT_USED', attempts: 0 }, whatsapp: { status: 'NOT_USED', attempts: 0 } });
      const set = await InviteeSet.create({ eventId: ev._id, name: 'list.xlsx', mode: 'APPEND', createdBy: organizer._id, importedCount: 1 });
      const r = await request(app).post(`/api/v1/events/${ev._id}/cleanup`).set(auth(tAdmin)).send({ confirmTitle: 'Audit Event' });
      expect(r.status).toBe(200);
      expect(await Invitee.countDocuments({ eventId: ev._id })).toBe(0);
      expect(await CredentialEvent.countDocuments({ eventId: ev._id })).toBe(0);
      expect(await CancellationNotice.countDocuments({ eventId: ev._id })).toBe(0);
      expect(await InviteeSet.countDocuments({ _id: set._id })).toBe(0);
      expect(await Event.exists({ _id: ev._id })).toBeTruthy();
    });
  });

  describe('H14 failures are reported as what they are', () => {
    it('a database outage is 503, not a generic 500', async () => {
      const { errorHandler } = await import('../src/middlewares/errorHandler');
      for (const name of ['MongoServerSelectionError', 'MongoNetworkError', 'MongoNotConnectedError']) {
        const json = jest.fn(); const status = jest.fn(() => ({ json }));
        errorHandler(Object.assign(new Error('x'), { name }), {} as any, { headersSent: false, status } as any, jest.fn());
        expect(status).toHaveBeenCalledWith(503);
      }
      const json = jest.fn(); const status = jest.fn(() => ({ json }));
      errorHandler(new Error('Operation `users.findOne()` buffering timed out after 10000ms'), {} as any, { headersSent: false, status } as any, jest.fn());
      expect(status).toHaveBeenCalledWith(503);
    });
    it('object storage that is not configured is reported as unavailable', async () => {
      const r = await request(app).post('/api/v1/media/presign').set(auth(tOrg)).send({ fileName: 'a.png', fileType: 'image/png' });
      expect(r.status).toBe(503);
    });
    it('the health endpoint tells whether the database is reachable', async () => {
      const r = await request(app).get('/api/health');
      expect(r.status).toBe(200);
      expect(r.body.database).toBe('connected');
    });
  });
});

// A one-member zip whose directory declares `declaredSize` for the member, whatever the data really inflates to.
function buildZip(declaredSize: number, data: Buffer): Buffer {
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(declaredSize, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(name.length, 28);
  const cdOffset = local.length + name.length + data.length;
  const cdSize = central.length + name.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
