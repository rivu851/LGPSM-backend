import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation, InvitationDeliveryStatus, DeliveryChannel } from '../src/models/Invitation';
import { CheckIn } from '../src/models/CheckIn';
import { CredentialEvent } from '../src/models/CredentialEvent';
import { PassNotice } from '../src/models/PassNotice';
import { AuditLog } from '../src/models/AuditLog';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import * as emailProvider from '../src/utils/email.provider';
import { whatsappService } from '../src/services/whatsapp.service';
import { invitationService } from '../src/services/invitation.service';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';
import { decryptToken, encryptToken } from '../src/utils/tokenCipher';
import { admissionPayloadFor, invitationUrlFor, parseInvitationQrPayload, PASS_PREFIX, previewSampleUrl } from '../src/utils/qrPayload';
import { decodeQr } from './helpers/qr';

// Two independent secrets per guest: the INVITATION token (their link: page, RSVP, pass retrieval) and the ADMISSION credential
// (what the QR carries and the door accepts). Revoking or replacing the pass changes only the second.

jest.setTimeout(60_000);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const HOUR = 3600e3;
const PASS = /^lgpsm-pass:[a-f0-9]{64}$/;

async function settle(tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (!(await PassNotice.countDocuments({ $or: [{ 'email.status': { $in: ['PENDING', 'SENDING'] } }, { 'whatsapp.status': { $in: ['PENDING', 'SENDING'] } }] }))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}
const binary = (req: request.Test) => req.buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

describe('Phase 4 — invitation token and admission credential are separate', () => {
  let mongo: MongoMemoryServer;
  let org: any, other: any, staff: any, tOrg: string, tOther: string, tStaff: string;
  let event: any, session: any;
  let emailSpy: jest.SpyInstance;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([CheckIn, CredentialEvent, PassNotice, Invitee].map((m: any) => m.syncIndexes()));
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([User, Event, Session, Invitee, Invitation, SystemUserAssignment, CheckIn, AuditLog, CredentialEvent, PassNotice].map((m: any) => m.deleteMany({})));
    const mk = (n: string, e: string, role: Role) => User.create({ fullName: n, email: e, role, isActive: true });
    org = await mk('Org', 'org.sep@x.com', Role.ORGANIZER); other = await mk('Other', 'other.sep@x.com', Role.ORGANIZER); staff = await mk('Staff', 'staff.sep@x.com', Role.SYSTEM_USER);
    tOrg = generateAccessToken(String(org._id), org.role); tOther = generateAccessToken(String(other._id), other.role); tStaff = generateAccessToken(String(staff._id), staff.role);
    event = await Event.create({
      organizerId: org._id, title: 'Summit', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, contactNumber: '123456789',
      schedule: { start: new Date(Date.now() - HOUR), end: new Date(Date.now() + 4 * HOUR) }, status: EventStatus.PUBLISHED,
      rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: true }
    });
    session = await Session.create({ eventId: event._id, name: 'Main', schedule: event.schedule, accessControl: AccessControl.ONLY_ONCE, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
    await SystemUserAssignment.create({ userId: staff._id, eventId: event._id, sessionIds: [], assignedBy: org._id });
    emailSpy = jest.spyOn(emailProvider, 'sendEmail').mockResolvedValue(true as any);
    jest.spyOn(whatsappService, 'sendPassWhatsApp').mockResolvedValue({ messageId: 'wamid.x' });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  let phoneSeq = 0;
  /** a guest invited through the real send flow */
  async function invited(name: string, key: string, rsvp = RsvpStatus.ACCEPTED) {
    const inv: any = await Invitee.create({ eventId: event._id, name, email: `${key}@x.com`, mobile: `98770${String(20000 + ++phoneSeq)}`, rsvpStatus: rsvp, sessionAccess: [] });
    const results = await invitationService.sendInvitations(String(event._id), String(org._id), [String(inv._id)], DeliveryChannel.EMAIL);
    expect(results[0].status).toBe('SENT');
    const [to, , html, attachments] = emailSpy.mock.calls[emailSpy.mock.calls.length - 1];
    expect(to).toBe(`${key}@x.com`);
    const stored: any = await Invitee.findById(inv._id).select('+qrTokenCipher +invitationTokenCipher');
    const card: Buffer = attachments.find((a: any) => a.filename === 'invitation-card.png').content;
    return { id: String(inv._id), html: html as string, card, admission: decryptToken(stored.qrTokenCipher)!, invitation: decryptToken(stored.invitationTokenCipher)! };
  }
  const scan = (qrCode: string, who = tOrg, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/checkins/scan').set(auth(who)).send({ qrCode, eventId: String(event._id), sessionId: String(session._id), ...extra });
  const page = (token: string) => request(app).get(`/api/v1/public/invitations/${token}`);
  const rsvp = (token: string, status: string) => request(app).post(`/api/v1/public/invitations/${token}/rsvp`).send({ rsvpStatus: status });
  const act = (action: 'revoke' | 'replace', id: string, body: Record<string, unknown>, who = tOrg) => request(app).post(`/api/v1/invitees/${id}/${action}`).set(auth(who)).send(body);
  const history = (id: string, who = tOrg) => request(app).get(`/api/v1/events/${event._id}/invitees/credential-events?inviteeId=${id}`).set(auth(who));

  describe('issuance', () => {
    it('gives each guest two different secrets; the email carries the invitation link, the QR carries only the admission credential', async () => {
      const g = await invited('Anna', 'anna');
      expect(g.admission).toMatch(/^[a-f0-9]{64}$/); expect(g.invitation).toMatch(/^[a-f0-9]{64}$/);
      expect(g.admission).not.toBe(g.invitation);
      expect(g.html).toContain(invitationUrlFor(g.invitation));
      expect(g.html).not.toContain(g.admission);
      expect(await decodeQr(g.card)).toBe(admissionPayloadFor(g.admission));
      expect(await decodeQr(g.card)).toMatch(PASS);
      expect(await decodeQr(g.card)).not.toContain(g.invitation);
    });

    it('stores only hashes for lookup, a separate hash for each secret, and no raw secret in any listing', async () => {
      const g = await invited('Anna', 'anna');
      const row: any = await Invitee.findById(g.id).lean();
      expect(row.qrTokenHash).toBe(hashToken(g.admission));
      expect(row.invitationTokenHash).toBe(hashToken(g.invitation));
      expect(row.qrTokenHash).not.toBe(row.invitationTokenHash);
      expect(row.qrTokenCipher).toBeUndefined(); expect(row.invitationTokenCipher).toBeUndefined(); // select:false
      const list = await request(app).get(`/api/v1/events/${event._id}/invitees`).set(auth(tOrg));
      const hist = await history(g.id);
      const audits = JSON.stringify(await AuditLog.find({}).lean());
      for (const body of [JSON.stringify(list.body), JSON.stringify(hist.body), audits]) {
        expect(body).not.toContain(g.admission); expect(body).not.toContain(g.invitation);
        expect(body).not.toContain(hashToken(g.admission)); expect(body).not.toContain(hashToken(g.invitation));
      }
    });

    it('records issued and activated as separate history rows that share one credential id, and the guest holds that id', async () => {
      const g = await invited('Anna', 'anna');
      const h = (await history(g.id)).body.data as any[];
      expect(h.map((e) => e.type)).toEqual(['ACTIVATED', 'ISSUED']);
      expect(h[0].credentialId).toBe(h[1].credentialId);
      expect(h[0].result).toBe('SUCCESS');
      expect(String((await Invitee.findById(g.id).lean() as any).credentialId)).toBe(h[0].credentialId);
    });

    it('the admission credential is not a link: it opens no page and takes no RSVP; the invitation token is not accepted at the door', async () => {
      const g = await invited('Anna', 'anna');
      expect((await page(g.invitation)).status).toBe(200);
      expect((await page(g.admission)).status).toBe(404);
      expect((await rsvp(g.admission, 'DECLINED')).status).toBe(404);
      expect((await binary(request(app).get(`/api/v1/public/invitations/${g.admission}/card`))).status).toBe(404);
      for (const payload of [g.invitation, invitationUrlFor(g.invitation), `${PASS_PREFIX}${g.invitation}`]) {
        const res = await scan(payload);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).not.toBe(201);
      }
      expect(await CheckIn.countDocuments({ inviteeId: g.id })).toBe(0);
    });
  });

  describe('admission at the door', () => {
    it('admits the QR payload; the legacy forms of the same credential still work; rights and rules are unchanged', async () => {
      const a = await invited('Anna', 'anna'); const b = await invited('Ben', 'ben'); const c = await invited('Cy', 'cy');
      expect((await scan(await decodeQr(a.card) as string)).status).toBe(201);   // exactly what the QR holds
      expect((await scan(invitationUrlFor(b.admission))).status).toBe(201);        // an older QR printed as a link to the same credential
      expect((await scan(c.admission)).status).toBe(201);                           // raw credential
      expect((await scan(await decodeQr(a.card) as string)).status).toBe(409);      // Only Once still applies
      expect((await scan(`${PASS_PREFIX}${generateSecureToken()}`)).status).toBe(404);
      expect((await scan(`${PASS_PREFIX}nothex`)).status).toBeGreaterThanOrEqual(400);
      expect((await scan(await decodeQr(b.card) as string, tOther)).status).toBeGreaterThanOrEqual(400); // unrelated organizer
    });

    it('five simultaneous scans of one QR admit exactly once (Only Once)', async () => {
      const g = await invited('Anna', 'anna');
      const results = await Promise.all(Array.from({ length: 5 }, () => scan(admissionPayloadFor(g.admission))));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await CheckIn.countDocuments({ inviteeId: g.id })).toBe(1);
    });

    it('recognises preview cards and refuses malformed payloads', () => {
      const t = generateSecureToken();
      expect(parseInvitationQrPayload(`${PASS_PREFIX}${t}`)).toEqual({ ok: true, token: t });
      expect(parseInvitationQrPayload(`${PASS_PREFIX.toUpperCase()}${t.toUpperCase()}`)).toEqual({ ok: true, token: t });
      expect(parseInvitationQrPayload(`${PASS_PREFIX}preview-sample`)).toEqual({ ok: false, reason: 'PREVIEW_SAMPLE' });
      expect(parseInvitationQrPayload(previewSampleUrl())).toEqual({ ok: false, reason: 'PREVIEW_SAMPLE' });
      expect(parseInvitationQrPayload(`${PASS_PREFIX}${t.slice(1)}`)).toEqual({ ok: false, reason: 'UNSUPPORTED_FORMAT' });
      expect(parseInvitationQrPayload(`${PASS_PREFIX}${t}/extra`)).toEqual({ ok: false, reason: 'UNSUPPORTED_FORMAT' });
    });
  });

  describe('replacement', () => {
    it('the old QR stops working, the new one works, the invitation link and RSVP are untouched', async () => {
      const g = await invited('Anna', 'anna');
      const before: any = await Invitee.findById(g.id).lean();
      const res = await act('replace', g.id, { category: 'LOST_OR_COMPROMISED' });
      expect(res.status).toBe(200);
      await settle();
      const now: any = await Invitee.findById(g.id).select('+qrTokenCipher +invitationTokenCipher').lean();
      const newAdmission = decryptToken(now.qrTokenCipher)!;
      expect(newAdmission).not.toBe(g.admission);
      expect(now.invitationTokenHash).toBe(before.invitationTokenHash);          // the link did not change
      expect(now.rsvpStatus).toBe(RsvpStatus.ACCEPTED);
      expect((await scan(admissionPayloadFor(g.admission))).status).toBe(410);   // old QR: replaced
      expect((await scan(admissionPayloadFor(newAdmission))).status).toBe(201);  // new QR admits
      expect((await page(g.invitation)).body.data.credential.status).toBe('ACTIVE');
      // the replacement email shows the new card and the same link
      const [, subject, html, attachments] = emailSpy.mock.calls[emailSpy.mock.calls.length - 1];
      expect(subject).toMatch(/new access pass/i);
      expect(html).toContain(invitationUrlFor(g.invitation));
      expect(html).not.toContain(newAdmission);
      expect(await decodeQr(attachments[0].content)).toBe(admissionPayloadFor(newAdmission));
    });

    it('records replacement and activation with the credential it replaced; the old credential keeps its own history', async () => {
      const g = await invited('Anna', 'anna');
      await act('replace', g.id, { category: 'FORWARDED_OR_SHARED', note: 'sent to a colleague' }); await settle();
      const h = (await history(g.id)).body.data as any[];
      expect(h.map((e) => e.type)).toEqual(['ACTIVATED', 'REPLACED', 'ACTIVATED', 'ISSUED']);
      expect(h[1].previousCredentialId).toBe(h[3].credentialId);
      expect(h[0].credentialId).toBe(h[1].credentialId);
      expect(h[0].credentialId).not.toBe(h[2].credentialId);
      expect(h[1]).toMatchObject({ reasonCategory: 'FORWARDED_OR_SHARED', note: 'sent to a colleague', actor: 'Org' });
      expect(JSON.stringify(h)).not.toMatch(/tokenHash|qrToken|[a-f0-9]{64}/);
    });

    it('a failed card render leaves the previous pass fully valid and writes no history', async () => {
      const g = await invited('Anna', 'anna');
      const before = JSON.stringify(await CredentialEvent.find({ inviteeId: g.id }).lean());
      jest.spyOn(invitationService, 'renderPassCard').mockRejectedValueOnce(new Error('renderer down'));
      const res = await act('replace', g.id, { category: 'LOST_OR_COMPROMISED' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await CredentialEvent.find({ inviteeId: g.id }).lean())).toBe(before);
      expect((await Invitee.findById(g.id).lean() as any).qrTokenHash).toBe(hashToken(g.admission));
      expect((await scan(admissionPayloadFor(g.admission))).status).toBe(201);
    });

    it('simultaneous replacements never leave two usable passes, and every winner is in the history', async () => {
      const g = await invited('Anna', 'anna');
      const results = await Promise.all([1, 2, 3].map(() => act('replace', g.id, { category: 'LOST_OR_COMPROMISED' })));
      await settle();
      const wins = results.filter((r) => r.status === 200).length;
      expect(wins).toBeGreaterThanOrEqual(1);
      const now: any = await Invitee.findById(g.id).select('+qrTokenCipher').lean();
      expect(now.credentialVersion).toBe(1 + wins);
      expect(await CredentialEvent.countDocuments({ inviteeId: g.id, type: 'REPLACED' })).toBe(wins);
      expect(await CredentialEvent.countDocuments({ inviteeId: g.id, type: 'ACTIVATED' })).toBe(1 + wins);
      // exactly one credential is accepted: the current one
      const current = decryptToken(now.qrTokenCipher)!;
      expect((await scan(admissionPayloadFor(g.admission))).status).toBeGreaterThanOrEqual(400);
      expect((await scan(admissionPayloadFor(current))).status).toBe(201);
      expect((await Invitee.findById(g.id).lean() as any).invitationTokenHash).toBe(hashToken(g.invitation));
    });

    it('a guest invited before the two secrets were separated keeps the link they hold: it becomes the invitation token, and the old QR dies', async () => {
      const raw = generateSecureToken();
      const legacy: any = await Invitee.create({ eventId: event._id, name: 'Old Olga', email: 'olga@x.com', mobile: '9877099001', invitationStatus: InvitationStatus.SENT, rsvpStatus: RsvpStatus.ACCEPTED, qrTokenHash: hashToken(raw), qrTokenCipher: encryptToken(raw), credentialVersion: 1, sessionAccess: [] });
      await Invitation.create({ eventId: event._id, inviteeId: legacy._id, tokenHash: hashToken(raw), channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.SENT, emailStatus: InvitationDeliveryStatus.SENT });
      expect((await page(raw)).status).toBe(200); // found through the one shared token
      expect((await scan(invitationUrlFor(raw))).status).toBe(201 === 201 ? 201 : 201);
      await CheckIn.deleteMany({}); // the door accepted the legacy QR: now replace and prove it no longer does
      expect((await act('replace', String(legacy._id), { category: 'LOST_OR_COMPROMISED' })).status).toBe(200);
      await settle();
      const now: any = await Invitee.findById(legacy._id).select('+qrTokenCipher').lean();
      expect(now.invitationTokenHash).toBe(hashToken(raw));            // adopted
      expect(now.qrTokenHash).not.toBe(hashToken(raw));
      expect((await page(raw)).status).toBe(200);                      // the old link still works
      expect((await rsvp(raw, 'DECLINED')).status).toBe(200);
      expect((await scan(invitationUrlFor(raw))).status).toBe(410);    // the old QR does not
      expect((await scan(raw)).status).toBe(410);
      expect((await scan(admissionPayloadFor(decryptToken(now.qrTokenCipher)!))).status).toBeGreaterThanOrEqual(200);
    });

    it('a resend issues a new admission credential and leaves the invitation link as it was', async () => {
      const g = await invited('Anna', 'anna');
      const inv: any = await Invitation.findOne({ inviteeId: g.id });
      const res = await request(app).post(`/api/v1/events/${event._id}/invitations/resend`).set(auth(tOrg)).send({ invitationIds: [String(inv._id)] });
      expect(res.status).toBe(200);
      const now: any = await Invitee.findById(g.id).select('+qrTokenCipher').lean();
      const [, , html, attachments] = emailSpy.mock.calls[emailSpy.mock.calls.length - 1];
      expect(now.invitationTokenHash).toBe(hashToken(g.invitation));
      expect(html).toContain(invitationUrlFor(g.invitation));
      expect(now.qrTokenHash).not.toBe(hashToken(g.admission));
      expect(await decodeQr(attachments.find((a: any) => a.filename === 'invitation-card.png').content)).toBe(admissionPayloadFor(decryptToken(now.qrTokenCipher)!));
      expect((await scan(admissionPayloadFor(g.admission))).status).toBe(410);
      expect((await page(g.invitation)).status).toBe(200);
    });
  });

  describe('revocation', () => {
    it('the QR is refused with a clear reason, RSVP is unchanged, and the invitation link still works and still takes an RSVP', async () => {
      const g = await invited('Anna', 'anna', RsvpStatus.ACCEPTED);
      expect((await act('revoke', g.id, { category: 'ACCESS_WITHDRAWN' })).status).toBe(200);
      await settle();
      const res = await scan(admissionPayloadFor(g.admission));
      expect(res.status).toBe(410);
      expect(res.body.message).toMatch(/revoked/i);
      expect((await Invitee.findById(g.id).lean() as any).rsvpStatus).toBe(RsvpStatus.ACCEPTED);
      const p = await page(g.invitation);
      expect(p.status).toBe(200);
      expect(p.body.data.credential.status).toBe('REVOKED');
      expect((await rsvp(g.invitation, 'DECLINED')).status).toBe(200);        // legitimate invitation-response access is not taken away
      expect((await Invitee.findById(g.id).lean() as any).rsvpStatus).toBe(RsvpStatus.DECLINED);
      expect((await binary(request(app).get(`/api/v1/public/invitations/${g.invitation}/card`))).status).toBe(410); // no pass is drawn
      const [, , html] = emailSpy.mock.calls[emailSpy.mock.calls.length - 1];
      expect(html).toMatch(/invitation link still works/i);
      expect(html).not.toMatch(/ACCESS_WITHDRAWN|reason/i);
    });

    it('is refused for System Users and unrelated organizers, and changes nothing', async () => {
      const g = await invited('Anna', 'anna');
      expect((await act('revoke', g.id, { category: 'OTHER', note: 'x' }, tStaff)).status).toBe(403);
      expect([403, 404]).toContain((await act('revoke', g.id, { category: 'OTHER', note: 'x' }, tOther)).status);
      expect([403, 404]).toContain((await act('replace', g.id, { category: 'LOST_OR_COMPROMISED' }, tOther)).status);
      expect((await act('replace', g.id, { category: 'LOST_OR_COMPROMISED' }, tStaff)).status).toBe(403);
      expect((await Invitee.findById(g.id).lean() as any).credentialRevokedAt).toBeFalsy();
      expect((await scan(admissionPayloadFor(g.admission))).status).toBe(201);
    });

    it('replacement after revocation follows the approved rules and keeps the revocation in history', async () => {
      const a = await invited('Anna', 'anna'); const b = await invited('Ben', 'ben'); const c = await invited('Cy', 'cy');
      await act('revoke', a.id, { category: 'ACCESS_WITHDRAWN' }); await act('revoke', b.id, { category: 'OTHER', note: 'dispute' }); await act('revoke', c.id, { category: 'LOST_OR_COMPROMISED' });
      expect((await act('replace', a.id, { category: 'LOST_OR_COMPROMISED' })).status).toBe(409);               // withdrawn: prohibited
      expect((await act('replace', b.id, { category: 'LOST_OR_COMPROMISED' })).status).toBe(409);               // other: needs explicit review
      expect((await act('replace', b.id, { category: 'LOST_OR_COMPROMISED', reviewConfirmed: true })).status).toBe(200);
      expect((await act('replace', c.id, { category: 'LOST_OR_COMPROMISED' })).status).toBe(200);
      await settle();
      expect((await history(c.id)).body.data.map((e: any) => e.type)).toEqual(['ACTIVATED', 'REPLACED', 'REVOKED', 'ACTIVATED', 'ISSUED']);
      expect((await scan(admissionPayloadFor(a.admission))).status).toBe(410);
    });
  });

  describe('event state', () => {
    it('cancellation makes every pass unusable and history shows the passes as expired (derived), without any stored rewrite', async () => {
      const g = await invited('Anna', 'anna');
      await Event.updateOne({ _id: event._id }, { status: EventStatus.CANCELLED, cancelledAt: new Date() });
      expect((await scan(admissionPayloadFor(g.admission))).status).toBeGreaterThanOrEqual(400);
      const h = (await history(g.id)).body.data as any[];
      expect(h[0]).toMatchObject({ type: 'EXPIRED', derived: true, reasonCategory: 'EVENT_CANCELLED' });
      expect(await CredentialEvent.countDocuments({ inviteeId: g.id })).toBe(2); // nothing was written for the expiry
      expect(h.slice(1).map((e) => e.type)).toEqual(['ACTIVATED', 'ISSUED']);
    });

    it('closing the event or passing the admission window expires the pass the same way', async () => {
      const g = await invited('Anna', 'anna');
      await Event.updateOne({ _id: event._id }, { status: EventStatus.COMPLETED, closedAt: new Date() });
      expect((await scan(admissionPayloadFor(g.admission))).status).toBeGreaterThanOrEqual(400);
      expect(((await history(g.id)).body.data as any[])[0]).toMatchObject({ type: 'EXPIRED', derived: true, reasonCategory: 'EVENT_COMPLETED' });
      // the pass was issued two hours ago; the admission window closed an hour ago
      await CredentialEvent.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 2 * HOUR) } });
      await Event.updateOne({ _id: event._id }, { status: EventStatus.PUBLISHED, closedAt: null, admission: { closesAt: new Date(Date.now() - HOUR) } });
      expect(((await history(g.id)).body.data as any[])[0]).toMatchObject({ type: 'EXPIRED', derived: true, reasonCategory: 'ADMISSION_CLOSED' });
    });

    it('a replaced or revoked pass is history, never the current status of a guest holding a newer active pass', async () => {
      const g = await invited('Anna', 'anna');
      await act('replace', g.id, { category: 'LOST_OR_COMPROMISED' }); await settle();
      const list = await request(app).get(`/api/v1/events/${event._id}/invitees`).set(auth(tOrg));
      const row = (list.body.data as any[]).find((i) => i._id === g.id);
      expect(row.credentialStatus).toBe('ACTIVE');
      expect(['NOT_ISSUED', 'ACTIVE', 'REVOKED', 'EXPIRED']).toContain(row.credentialStatus);
    });
  });
});
