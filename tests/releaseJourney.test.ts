import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as xlsx from 'xlsx';
import bcrypt from 'bcrypt';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { CheckIn } from '../src/models/CheckIn';
import { AuditLog } from '../src/models/AuditLog';
import { CredentialEvent } from '../src/models/CredentialEvent';
import { PassNotice } from '../src/models/PassNotice';
import { CancellationNotice } from '../src/models/CancellationNotice';
import * as emailProvider from '../src/utils/email.provider';
import { whatsappService } from '../src/services/whatsapp.service';
import { decryptToken } from '../src/utils/tokenCipher';
import { admissionPayloadFor, invitationUrlFor } from '../src/utils/qrPayload';
import { decodeQr } from './helpers/qr';

// The whole product through its HTTP API in one database, as the three kinds of user would use it. Every response body and
// every line the server logs is recorded and, at the end, searched for secrets.
jest.setTimeout(240_000);

describe('release journey: admin, organizer, staff and attendee', () => {
  let mongo: MongoMemoryServer;
  const clickToChat: string[] = []; const bodies: string[] = []; const logs: string[] = []; const bodyMeta: string[] = []; const kind = new Map<string, string>();
  const mails: { to: string; subject: string; html: string; card?: Buffer }[] = [];
  const PASSWORD = 'JourneyPass123!';
  let tOrg = '', tAdmin = '', tStaff = '', tOther = '';
  let staffId = '', eventId = '', sessionId = '';
  const secrets = new Set<string>();
  const call = async (req: request.Test) => { const res = await req; bodyMeta.push(`${(req as any).method} ${String((req as any).url).replace(/[a-f0-9]{64}/gi, ':token')}`); bodies.push(JSON.stringify(res.body ?? {}, (k, v) => { if (k === 'whatsappWebUrl' && typeof v === 'string') { clickToChat.push(v); return '[click-to-chat link]'; } return v; }) + (typeof res.text === 'string' && !res.body ? res.text : '')); return res; };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sheet = (rows: (string | number)[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'I'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };
  const login = (email: string, role: string) => call(request(app).post('/api/auth/login').send({ email, password: PASSWORD, role }));
  const scan = (token: string, who: string, extra: Record<string, unknown> = {}) => call(request(app).post('/api/v1/checkins/scan').set(auth(who)).send({ qrCode: admissionPayloadFor(token), eventId, sessionId, ...extra }));
  const tokensOf = async (name: string) => { const g: any = await Invitee.findOne({ name }).select('+qrTokenCipher +invitationTokenCipher'); const t = { id: String(g._id), admission: decryptToken(g.qrTokenCipher)!, invitation: decryptToken(g.invitationTokenCipher)!, qrTokenHash: g.qrTokenHash, invitationTokenHash: g.invitationTokenHash }; ([['admission', t.admission], ['invitation', t.invitation], ['qrTokenHash', t.qrTokenHash], ['invitationTokenHash', t.invitationTokenHash]] as const).forEach(([k, v]) => { secrets.add(String(v)); kind.set(String(v), k); }); return t; };
  const settle = async () => { for (let i = 0; i < 100; i++) { if (!(await PassNotice.countDocuments({ $or: [{ 'email.status': { $in: ['PENDING', 'SENDING'] } }] }))) return; await new Promise((r) => setTimeout(r, 25)); } };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([CheckIn, CredentialEvent, PassNotice, Invitee].map((m: any) => m.syncIndexes()));
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const mk = (fullName: string, email: string, role: Role, extra = {}) => User.create({ fullName, email, passwordHash, role, isActive: true, isEmailVerified: true, phone: '9000000000', ...extra });
    const org = await mk('Priya Organizer', 'priya.j@x.com', Role.ORGANIZER); await mk('Other Organizer', 'other.j@x.com', Role.ORGANIZER); await mk('Admin Root', 'admin.j@x.com', Role.ADMIN);
    await mk('Stan Staff', 'stan.j@x.com', Role.SYSTEM_USER, { createdBy: org._id }); await mk('Sue Stranger', 'sue.j@x.com', Role.SYSTEM_USER);
    for (const [k, fn] of [['log', 'log'], ['error', 'error'], ['warn', 'warn'], ['info', 'info']] as const) jest.spyOn(console, fn).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, Object.getOwnPropertyNames(x as object)))).join(' ')); });
    jest.spyOn(emailProvider, 'sendEmail').mockImplementation((async (to: string, subject: string, html: string, att?: any[]) => { mails.push({ to, subject, html, card: att?.find((a) => /card|pass/.test(a.filename))?.content }); return true; }) as any);
    jest.spyOn(whatsappService, 'sendPassWhatsApp').mockResolvedValue({ messageId: 'wamid.x' });
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('authentication and portals: each role signs in through its own tab, and the wrong tab is refused', async () => {
    const o = await login('priya.j@x.com', 'ORGANIZER'); const a = await login('admin.j@x.com', 'ADMIN'); const s = await login('stan.j@x.com', 'SYSTEM_USER'); const x = await login('other.j@x.com', 'ORGANIZER');
    for (const r of [o, a, s, x]) expect(r.status).toBe(200);
    tOrg = o.body.data.accessToken; tAdmin = a.body.data.accessToken; tStaff = s.body.data.accessToken; tOther = x.body.data.accessToken;
    expect((await login('admin.j@x.com', 'ORGANIZER')).status).toBe(403);
    expect((await call(request(app).post('/api/auth/login').send({ email: 'priya.j@x.com', password: 'wrong-password', role: 'ORGANIZER' }))).status).toBe(401);
    expect((await call(request(app).get('/api/v1/events'))).status).toBe(401);
    expect((await call(request(app).get('/api/v1/events').set(auth(tStaff)))).status).toBe(403); // staff do not list events
    staffId = String((await User.findOne({ email: 'stan.j@x.com' }))!._id);
  });

  it('organizer: creates an event with a session and food options, imports guests, assigns staff', async () => {
    const start = new Date(Date.now() - 3600e3).toISOString(), end = new Date(Date.now() + 4 * 3600e3).toISOString();
    const ev = await call(request(app).post('/api/v1/events').set(auth(tOrg)).send({ title: 'Release Summit', description: 'journey', format: 'PHYSICAL', location: { address: 'Grand Hall', addressDetails: 'Gate 3' }, contactNumber: '123456789', schedule: { start, end }, rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: true }, dietaryPreference: { enabled: true, title: 'Food', options: ['Veg', 'Non-Veg'] } }));
    expect(ev.status).toBe(201);
    eventId = ev.body.data.eventId || ev.body.data._id;
    expect((await call(request(app).patch(`/api/v1/events/${eventId}`).set(auth(tOther)).send({ title: 'Hijacked' }))).status).toBeGreaterThanOrEqual(403);
    const ses = await call(request(app).post(`/api/v1/events/${eventId}/sessions`).set(auth(tOrg)).send({ name: 'Main Hall', schedule: { start, end }, accessControl: 'ONLY_ONCE', validateAgainstOtherSessions: false }));
    expect(ses.status).toBe(201); sessionId = ses.body.data._id || ses.body.data.sessionId;
    const imp = await call(request(app).post(`/api/v1/events/${eventId}/invitees/import`).set(auth(tOrg)).field('mode', 'APPEND').attach('file', sheet([['Name', 'Email', 'Mobile'], ['Alice Attendee', 'alice@guest.test', '9871100001'], ['Bob Replaced', 'bob@guest.test', '9871100002'], ['Cara Revoked', 'cara@guest.test', '9871100003'], ['Dan Declines', 'dan@guest.test', '9871100004']]), 'guests.xlsx'));
    expect(imp.status).toBe(200); expect(imp.body.data.imported).toBe(4);
    expect((await call(request(app).post(`/api/v1/events/${eventId}/assignments`).set(auth(tOrg)).send({ userId: staffId, sessionIds: [] }))).status).toBeLessThan(300);
    const list = await call(request(app).get(`/api/v1/events/${eventId}/invitees`).set(auth(tOrg)));
    expect(list.body.data).toHaveLength(4);
    // staff of another organizer, and staff not assigned: refused
    const sueTok = (await login('sue.j@x.com', 'SYSTEM_USER')).body.data.accessToken;
    expect((await call(request(app).get(`/api/v1/events/${eventId}`).set(auth(sueTok)))).status).toBeGreaterThanOrEqual(403);
  });

  it('invitations are sent through the real flow; each guest gets a link and a card whose QR is a different secret', async () => {
    const ids = (await Invitee.find({ eventId }).select('_id').lean()).map((i: any) => String(i._id));
    const send = await call(request(app).post(`/api/v1/events/${eventId}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: ids, channel: 'EMAIL' }));
    expect(send.status).toBe(200);
    expect(mails.filter((m) => /Invitation/.test(m.subject))).toHaveLength(4);
    const alice = await tokensOf('Alice Attendee');
    const mail = mails.find((m) => m.to === 'alice@guest.test')!;
    expect(mail.html).toContain(invitationUrlFor(alice.invitation));
    expect(mail.html).not.toContain(alice.admission);
    expect(await decodeQr(mail.card!)).toBe(admissionPayloadFor(alice.admission));
    expect(alice.invitation).not.toBe(alice.admission);
    for (const n of ['Bob Replaced', 'Cara Revoked', 'Dan Declines']) await tokensOf(n);
    expect((await call(request(app).get(`/api/v1/events/${eventId}/invitees`).set(auth(tOrg)))).body.data.every((g: any) => g.invitationStatus === 'SENT' && g.credentialStatus === 'ACTIVE')).toBe(true);
  });

  it('attendee: opens only their own page, answers the RSVP and food choice, sees their current pass', async () => {
    const alice = await tokensOf('Alice Attendee'); const dan = await tokensOf('Dan Declines');
    const page = await call(request(app).get(`/api/v1/public/invitations/${alice.invitation}`));
    expect(page.status).toBe(200);
    expect(page.body.data.invitee.name).toBe('Alice Attendee');
    expect(JSON.stringify(page.body)).not.toMatch(/Bob|Cara|Dan Declines|bob@|cara@|dan@|9871100/);        // nobody else's details
    expect(page.body.data.credential.status).toBe('ACTIVE');
    expect((await call(request(app).post(`/api/v1/public/invitations/${alice.invitation}/rsvp`).send({ rsvpStatus: 'ACCEPTED', dietaryPreference: 'Veg' }))).status).toBe(200);
    expect((await call(request(app).post(`/api/v1/public/invitations/${alice.invitation}/rsvp`).send({ rsvpStatus: 'ACCEPTED', dietaryPreference: 'Pizza' }))).status).toBe(400);
    expect((await call(request(app).post(`/api/v1/public/invitations/${dan.invitation}/rsvp`).send({ rsvpStatus: 'DECLINED', dietaryPreference: 'Veg' }))).status).toBe(400);
    expect((await call(request(app).post(`/api/v1/public/invitations/${dan.invitation}/rsvp`).send({ rsvpStatus: 'DECLINED' }))).status).toBe(200);
    const stored: any = await Invitee.findById(alice.id).lean();
    expect(stored.rsvpStatus).toBe('ACCEPTED'); expect(stored.dietaryPreference).toBe('Veg');
    // the admission credential is not a link, the link is not a pass
    expect((await call(request(app).get(`/api/v1/public/invitations/${alice.admission}`))).status).toBe(404);
    expect((await scan(alice.invitation, tStaff)).status).toBeGreaterThanOrEqual(400);
    // the pass drawn behind the link is the current one
    const card = await request(app).get(`/api/v1/public/invitations/${alice.invitation}/card`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(await decodeQr(card.body)).toBe(admissionPayloadFor(alice.admission));
  });

  it('staff admits through the QR, the rules apply, and attendance reaches the reports', async () => {
    const alice = await tokensOf('Alice Attendee');
    const ok = await scan(alice.admission, tStaff);
    expect(ok.status).toBe(201);
    expect((await scan(alice.admission, tStaff)).status).toBe(409);                                  // Only Once
    const sueTok = (await login('sue.j@x.com', 'SYSTEM_USER')).body.data.accessToken;
    expect((await scan((await tokensOf('Dan Declines')).admission, sueTok)).status).toBeGreaterThanOrEqual(403); // not assigned to this event
    expect((await scan(alice.admission, tOther)).status).toBeGreaterThanOrEqual(403);
    const report = await call(request(app).get(`/api/v1/reports/events/${eventId}`).set(auth(tOrg)));
    expect(report.status).toBe(200);
    expect(report.body.data).toMatchObject({ totalInvitees: 4, totalCheckIns: 1, uniqueAttendees: 1 });
    expect((await call(request(app).get(`/api/v1/reports/events/${eventId}`).set(auth(tOther)))).status).toBeGreaterThanOrEqual(403);
    expect((await call(request(app).get(`/api/v1/reports/events/${eventId}`).set(auth(tAdmin)))).status).toBe(200);
    expect(await CheckIn.countDocuments({ eventId })).toBe(1);
  });

  it('credential management: replace (organizer) and revoke (admin); the links and RSVPs survive; old and revoked QRs are refused', async () => {
    const bob = await tokensOf('Bob Replaced'); const cara = await tokensOf('Cara Revoked');
    const rep = await call(request(app).post(`/api/v1/invitees/${bob.id}/replace`).set(auth(tOrg)).send({ category: 'LOST_OR_COMPROMISED' }));
    expect(rep.status).toBe(200); await settle();
    const nowBob: any = await Invitee.findById(bob.id).select('+qrTokenCipher').lean();
    const bobNew = decryptToken(nowBob.qrTokenCipher)!; secrets.add(bobNew); secrets.add(nowBob.qrTokenHash);
    expect((await scan(bob.admission, tStaff)).status).toBe(410);
    expect((await scan(bobNew, tStaff)).status).toBe(201);
    expect((await call(request(app).get(`/api/v1/public/invitations/${bob.invitation}`))).body.data.credential.status).toBe('ACTIVE');
    expect(mails.find((m) => m.to === 'bob@guest.test' && /new access pass/i.test(m.subject))).toBeTruthy();
    expect((await call(request(app).post(`/api/v1/invitees/${cara.id}/revoke`).set(auth(tAdmin)).send({ category: 'ACCESS_WITHDRAWN' }))).status).toBe(200); await settle();
    expect((await scan(cara.admission, tStaff)).status).toBe(410);
    expect((await call(request(app).post(`/api/v1/public/invitations/${cara.invitation}/rsvp`).send({ rsvpStatus: 'DECLINED' }))).status).toBe(200);
    expect((await call(request(app).post(`/api/v1/invitees/${cara.id}/replace`).set(auth(tAdmin)).send({ category: 'LOST_OR_COMPROMISED' }))).status).toBe(409); // withdrawn
    expect((await call(request(app).post(`/api/v1/invitees/${cara.id}/revoke`).set(auth(tStaff)).send({ category: 'OTHER', note: 'x' }))).status).toBe(403);
    expect((await call(request(app).post(`/api/v1/invitees/${cara.id}/revoke`).set(auth(tOther)).send({ category: 'OTHER', note: 'x' }))).status).toBeGreaterThanOrEqual(403);
    const hist = await call(request(app).get(`/api/v1/events/${eventId}/invitees/credential-events`).set(auth(tOrg)));
    expect(hist.body.data.map((h: any) => h.type)).toEqual(expect.arrayContaining(['ISSUED', 'ACTIVATED', 'REPLACED', 'REVOKED']));
  });

  it('invitee lists: a Replace sets aside only never-invited guests; they can be restored; sent guests are untouched', async () => {
    await call(request(app).post(`/api/v1/events/${eventId}/invitees/import`).set(auth(tOrg)).field('mode', 'APPEND').attach('file', sheet([['Name', 'Email'], ['Draft Dee', 'dee@guest.test'], ['Draft Dan', 'dan2@guest.test']]), 'draft.xlsx'));
    const rep = await call(request(app).post(`/api/v1/events/${eventId}/invitees/import`).set(auth(tOrg)).field('mode', 'REPLACE').attach('file', sheet([['Name', 'Email'], ['Fresh Fay', 'fay@guest.test']]), 'fresh.xlsx'));
    expect(rep.body.data).toMatchObject({ archived: 2, imported: 1 });
    expect(await Invitee.countDocuments({ eventId, name: { $in: ['Alice Attendee', 'Bob Replaced', 'Cara Revoked', 'Dan Declines'] } })).toBe(4);
    const aside = await call(request(app).get(`/api/v1/events/${eventId}/invitees/set-aside`).set(auth(tOrg)));
    expect(aside.body.data.total).toBe(2);
    const dee = aside.body.data.guests.find((g: any) => g.name === 'Draft Dee');
    expect((await call(request(app).post(`/api/v1/events/${eventId}/invitees/set-aside/restore`).set(auth(tOrg)).send({ inviteeIds: [dee.id] }))).body.data.restored).toBe(1);
    expect((await call(request(app).get(`/api/v1/events/${eventId}/invitees/set-aside`).set(auth(tStaff)))).status).toBe(403);
  });

  it('closure: the event completes, passes expire through the event, attendance and history are kept', async () => {
    expect((await call(request(app).post(`/api/v1/events/${eventId}/close`).set(auth(tOrg)))).status).toBeLessThan(300);
    const bob = await tokensOf('Bob Replaced');
    const after = await scan(decryptToken(((await Invitee.findById(bob.id).select('+qrTokenCipher').lean()) as any).qrTokenCipher)!, tStaff);
    expect(after.status).toBeGreaterThanOrEqual(400);
    expect(await CheckIn.countDocuments({ eventId })).toBe(2);
    const e: any = await Event.findById(eventId).lean();
    expect(e.status).toBe('COMPLETED'); expect(e.finalAdmissionSeq).toBe(2);
    const hist = await call(request(app).get(`/api/v1/events/${eventId}/invitees/credential-events`).set(auth(tOrg)));
    expect(hist.body.data.some((h: any) => h.type === 'EXPIRED' && h.derived)).toBe(true);
    expect((await call(request(app).post(`/api/v1/invitees/${bob.id}/replace`).set(auth(tOrg)).send({ category: 'LOST_OR_COMPROMISED' }))).status).toBeGreaterThanOrEqual(400); // a closed event is not re-issued
  });

  it('cancellation: guests who were invited are told once, passes stop working, history is kept', async () => {
    const start = new Date(Date.now() - 3600e3).toISOString(), end = new Date(Date.now() + 4 * 3600e3).toISOString();
    const ev2 = (await call(request(app).post('/api/v1/events').set(auth(tOrg)).send({ title: 'Called Off', description: 'd', format: 'PHYSICAL', location: { address: 'Hall' }, contactNumber: '123456789', schedule: { start, end } }))).body.data;
    const id2 = ev2.eventId || ev2._id;
    await call(request(app).post(`/api/v1/events/${id2}/invitees`).set(auth(tOrg)).send({ name: 'Eve Event', email: 'eve@guest.test', mobile: '9871100009' }));
    const eve: any = await Invitee.findOne({ name: 'Eve Event' });
    await call(request(app).post(`/api/v1/events/${id2}/invitations/send`).set(auth(tOrg)).send({ inviteeIds: [String(eve._id)], channel: 'EMAIL' }));
    const eveTok = await (async () => { const g: any = await Invitee.findById(eve._id).select('+qrTokenCipher +invitationTokenCipher'); const t = { adm: decryptToken(g.qrTokenCipher)!, inv: decryptToken(g.invitationTokenCipher)! }; secrets.add(t.adm); secrets.add(t.inv); kind.set(t.adm, 'admission'); kind.set(t.inv, 'invitation'); return t; })();
    mails.length = 0;
    const cancel = await call(request(app).post(`/api/v1/events/${id2}/cancel`).set(auth(tOrg)).send({ reason: 'Venue unavailable' }));
    expect(cancel.status).toBe(200);
    for (let i = 0; i < 100 && (await CancellationNotice.countDocuments({ eventId: id2, 'email.status': { $in: ['PENDING', 'SENDING'] } })); i++) await new Promise((r) => setTimeout(r, 25));
    expect(mails.filter((m) => m.to === 'eve@guest.test')).toHaveLength(1);
    expect((await call(request(app).post('/api/v1/checkins/scan').set(auth(tStaff)).send({ qrCode: admissionPayloadFor(eveTok.adm), eventId: id2 }))).status).toBeGreaterThanOrEqual(400);
    const page = await call(request(app).get(`/api/v1/public/invitations/${eveTok.inv}`));
    expect(page.body.data.event.status).toBe('CANCELLED');
    expect((await call(request(app).post(`/api/v1/events/${id2}/cancel`).set(auth(tOrg)).send({ reason: 'again' }))).status).toBe(200);
    expect(mails.filter((m) => m.to === 'eve@guest.test')).toHaveLength(1); // no second message
    expect(await Invitee.countDocuments({ eventId: id2 })).toBe(1);        // nothing was deleted
  });

  it('audit trail: critical actions are recorded for the right tenant, and the organizer reads only their own', async () => {
    const mine = await call(request(app).get(`/api/v1/audit-logs?eventId=${eventId}&limit=100`).set(auth(tOrg)));
    expect(mine.status).toBe(200);
    const actions = (mine.body.data as any[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['INVITEE_IMPORT', 'CREDENTIAL_REPLACE', 'CREDENTIAL_REVOKE', 'EVENT_CLOSE', 'INVITEE_RESTORE']));
    const theirs = await call(request(app).get(`/api/v1/audit-logs?eventId=${eventId}`).set(auth(tOther)));
    expect(theirs.status === 200 ? theirs.body.data.length : 0).toBe(0);
    expect((await call(request(app).get(`/api/v1/audit-logs?eventId=${eventId}`).set(auth(tStaff)))).status).toBe(403);
  });

  it('nothing secret ever reached an API response or a log line', async () => {
    expect(secrets.size).toBeGreaterThan(10);
    // By design the send response hands the organizer a WhatsApp click-to-chat link per guest to share by hand. It carries the guest's
    // INVITATION link (so whoever holds it can open that guest's page and fetch their current pass), and never an admission credential or a hash.
    expect(clickToChat.length).toBeGreaterThan(0);
    for (const url of clickToChat) for (const [value, k] of kind) if (k !== 'invitation') expect(url.includes(value)).toBe(false);
    const allBodies = bodies.join('\n'), allLogs = logs.join('\n');
    const leaked = [...secrets].filter((s) => allBodies.includes(s) || allLogs.includes(s));
    const where = leaked.map((x) => `${kind.get(x) ?? 'other'} in ${bodies.map((b, i) => (b.includes(x) ? bodyMeta[i] : '')).filter(Boolean).join(' | ') || 'LOG'}${allLogs.includes(x) ? ' + LOG' : ''}`);
    expect(where).toEqual([]);                                                // (kinds and endpoints only, never a value)
    expect(await AuditLog.countDocuments({})).toBeGreaterThan(5);
    const audits = JSON.stringify(await AuditLog.find({}).lean()); const hist = JSON.stringify(await CredentialEvent.find({}).lean().then((r) => r.map(({ tokenHash, ...x }: any) => x)));
    for (const s of secrets) { expect(audits.includes(s)).toBe(false); expect(hist.includes(s)).toBe(false); }
    expect(allBodies).not.toMatch(/passwordHash|JourneyPass123|qrTokenCipher|invitationTokenCipher/);
    expect(allLogs).not.toMatch(/JourneyPass123/);
  });
});
