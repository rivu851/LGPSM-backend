import mongoose from 'mongoose';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import * as xlsx from 'xlsx';
import { User, Role } from '../src/models/User';
import { Event, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation, InvitationDeliveryStatus } from '../src/models/Invitation';
import { CheckIn } from '../src/models/CheckIn';
import { CredentialEvent } from '../src/models/CredentialEvent';
import { PassNotice } from '../src/models/PassNotice';
import { InviteeSet } from '../src/models/InviteeSet';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';
import { encryptToken, decryptToken } from '../src/utils/tokenCipher';
import { admissionPayloadFor } from '../src/utils/qrPayload';
import * as mainEmail from '../src/utils/email.provider';
import { whatsappService as mainWhatsApp } from '../src/services/whatsapp.service';

// Production-like validation: a replica set (so multi-document transactions are really used) and TWO independent copies of the
// application (separate module registries, connections, models and in-process locks) sharing it. Nothing in-process can
// coordinate them: consistent outcomes here come from the database operations themselves.
jest.setTimeout(240_000);

let rsProc: ChildProcess;
let org: any;
interface Instance {
  m: typeof mongoose; Invitee: typeof Invitee;
  credentialService: any; checkInService: any; eventService: any; inviteeService: any; inviteeSetService: any; passNoticeService: any;
  emailProvider: any; whatsappService: any;
}
let A: Instance, B: Instance;
let emailCalls: { inst: string; to: string }[] = [];

function loadInstance(label: string): Instance {
  let inst: any;
  jest.isolateModules(() => {
    const m = require('mongoose');
    const models = require('../src/models/Invitee');
    for (const n of ['InviteeSet', 'Invitation', 'CheckIn', 'CredentialEvent', 'PassNotice', 'Event', 'User', 'Session', 'AuditLog', 'SystemUserAssignment', 'CancellationNotice']) require(`../src/models/${n}`);
    const emailProvider = require('../src/utils/email.provider');
    const whatsappService = require('../src/services/whatsapp.service').whatsappService;
    jest.spyOn(emailProvider, 'sendEmail').mockImplementation((async (to: string) => { emailCalls.push({ inst: label, to }); return true; }) as any);
    jest.spyOn(whatsappService, 'sendPassWhatsApp').mockResolvedValue({ messageId: 'wamid.x' });
    inst = {
      m, Invitee: models.Invitee, emailProvider, whatsappService,
      credentialService: require('../src/services/credential.service').credentialService, checkInService: require('../src/services/checkIn.service').checkInService,
      eventService: require('../src/services/event.service').eventService, inviteeService: require('../src/services/invitee.service').inviteeService,
      inviteeSetService: require('../src/services/inviteeSet.service').inviteeSetService, passNoticeService: require('../src/services/passNotice.service').passNoticeService
    };
  });
  return inst;
}

const HOUR = 3600e3;
const actor = () => ({ userId: String(org._id), role: Role.ORGANIZER });
let phone = 0;
async function mkEvent() {
  const ev: any = await Event.create({ organizerId: org._id, title: 'RS', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', status: EventStatus.PUBLISHED, contactNumber: '123456789',
    schedule: { start: new Date(Date.now() - HOUR), end: new Date(Date.now() + 4 * HOUR) }, rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: true } } as any);
  const session: any = await Session.create({ eventId: ev._id, name: 'Main', schedule: ev.schedule, accessControl: AccessControl.ONLY_ONCE, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
  return { ev, session };
}
/** a guest holding a separated pass, invited by email (so a replacement has a channel to tell) */
async function mkGuest(ev: any, name = 'Guest') {
  const admission = generateSecureToken(), invitation = generateSecureToken();
  const g: any = await Invitee.create({ eventId: ev._id, name, email: `g${Math.random().toString(36).slice(2)}@x.com`, mobile: `98780${String(10000 + ++phone)}`, invitationStatus: InvitationStatus.SENT, rsvpStatus: RsvpStatus.ACCEPTED, sessionAccess: [],
    qrTokenHash: hashToken(admission), qrTokenCipher: encryptToken(admission), invitationTokenHash: hashToken(invitation), invitationTokenCipher: encryptToken(invitation), credentialVersion: 1, credentialId: new mongoose.Types.ObjectId() });
  await Invitation.create({ eventId: ev._id, inviteeId: g._id, tokenHash: hashToken(admission), channel: 'EMAIL', status: InvitationDeliveryStatus.SENT, emailStatus: InvitationDeliveryStatus.SENT } as any);
  await CredentialEvent.create({ eventId: ev._id, inviteeId: g._id, organizerId: org._id, type: 'ISSUED', version: 1, source: 'SEND', credentialId: g.credentialId, tokenHash: hashToken(admission) });
  return { g, admission, invitation };
}
const scan = (inst: Instance, ev: any, session: any, token: string) =>
  inst.checkInService.scanCheckIn(actor(), { qrCode: admissionPayloadFor(token), eventId: String(ev._id), sessionId: String(session._id) }).then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, code: e?.message, err: e }));
const sheet = (rows: (string | number)[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'I'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };
const settle = async (ms = 400) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  // the replica set lives in its own process (see tests/helpers/replSetProcess.js)
  rsProc = spawn(process.execPath, [path.join(__dirname, 'helpers', 'replSetProcess.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const uri: string = await new Promise((resolve, reject) => {
    let buf = '';
    rsProc.stdout!.on('data', (d) => { buf += d.toString(); const m = /URI (\S+)/.exec(buf); if (m) resolve(m[1]); });
    rsProc.on('exit', () => reject(new Error('replica set did not start: ' + buf)));
    setTimeout(() => reject(new Error('replica set start timed out')), 90_000);
  });
  await mongoose.connect(uri);
  org = await User.create({ fullName: 'Org', email: 'org.rs@x.com', role: Role.ORGANIZER, isActive: true });
  // a dynamic import inside a service resolves in the main module registry, so that registry's provider is stubbed as well
  jest.spyOn(mainEmail, 'sendEmail').mockImplementation((async (to: string) => { emailCalls.push({ inst: 'main', to }); return true; }) as any);
  jest.spyOn(mainWhatsApp, 'sendPassWhatsApp').mockResolvedValue({ messageId: 'wamid.x' } as any);
  A = loadInstance('A'); B = loadInstance('B');
  await Promise.all([A.m.connect(uri), B.m.connect(uri)]);
  // collection creation needs a majority acknowledgement: retry briefly if the set is still settling under load
  const retry = async <T>(fn: () => Promise<T>) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 1000)); } } };
  await retry(() => Promise.all([Invitee, CheckIn, CredentialEvent, PassNotice, Event, Session].map((m: any) => m.init())));
  await retry(() => Promise.all([A.Invitee.init(), B.Invitee.init()]));
});
afterAll(async () => { await Promise.all([A.m.disconnect(), B.m.disconnect(), mongoose.disconnect()]); rsProc.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); });
beforeEach(() => { emailCalls = []; });

describe('replica set, two application instances', () => {
  it('is a real replica set with transactions, and the instances are independent', async () => {
    const hello: any = await mongoose.connection.db!.admin().command({ hello: 1 });
    expect(hello.setName).toBeTruthy();
    expect(hello.hosts?.length).toBeGreaterThanOrEqual(2);
    expect(A.m).not.toBe(B.m);
    expect(A.credentialService).not.toBe(B.credentialService);
    expect(await A.m.connection.db!.admin().command({ hello: 1 }).then((h: any) => !!h.setName)).toBe(true);
  });

  it('credential replacement races: simultaneous replacements from both instances leave exactly one valid pass and a complete history', async () => {
    for (let i = 0; i < 4; i++) {
      const { ev, session } = await mkEvent(); const { g, admission, invitation } = await mkGuest(ev);
      const [r1, r2] = await Promise.all([
        A.credentialService.replace(actor(), String(g._id), { category: 'LOST_OR_COMPROMISED' }).then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, code: e?.message })),
        B.credentialService.replace(actor(), String(g._id), { category: 'LOST_OR_COMPROMISED' }).then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, code: e?.message }))
      ]);
      await settle();
      const wins = [r1, r2].filter((r) => r.ok).length;
      expect(wins).toBeGreaterThanOrEqual(1);
      for (const r of [r1, r2]) if (!r.ok) expect(r.code).toBe('CONFLICT');
      const now: any = await Invitee.findById(g._id).select('+qrTokenCipher +invitationTokenCipher').lean();
      expect(now.credentialVersion).toBe(1 + wins);
      expect(now.invitationTokenHash).toBe(hashToken(invitation));          // the link never moved
      expect(await CredentialEvent.countDocuments({ inviteeId: g._id, type: 'REPLACED' })).toBe(wins);
      expect(await CredentialEvent.countDocuments({ inviteeId: g._id, type: 'ACTIVATED' })).toBe(wins);
      const current = decryptToken(now.qrTokenCipher)!;
      expect(hashToken(current)).toBe(now.qrTokenHash);                      // cipher and hash agree
      expect((await scan(A, ev, session, admission)).ok).toBe(false);         // the original pass is dead
      expect((await scan(B, ev, session, current)).ok).toBe(true);            // exactly the current one works
      expect(await PassNotice.countDocuments({ inviteeId: g._id })).toBe(wins); // one notice per successful replacement
    }
  });

  it('replacement against check-in: the old pass is admitted at most once and never after the swap; the new one is never lost', async () => {
    const tally = { admittedBeforeSwap: 0, refused: 0 };
    for (let i = 0; i < 6; i++) {
      const { ev, session } = await mkEvent(); const { g, admission } = await mkGuest(ev);
      const [rep, sc] = await Promise.all([A.credentialService.replace(actor(), String(g._id), { category: 'FORWARDED_OR_SHARED' }), scan(B, ev, session, admission)]);
      await settle();
      expect(rep.invitee).toBeTruthy();
      const checkIns = await CheckIn.countDocuments({ inviteeId: g._id });
      if (sc.ok) { tally.admittedBeforeSwap++; expect(checkIns).toBe(1); }
      else { tally.refused++; expect(sc.code).toBe('QR_TOKEN_SUPERSEDED'); expect(checkIns).toBe(0); }
      const after = await scan(A, ev, session, admission);                   // once the swap is committed the old pass can never admit
      expect(after.ok).toBe(false);
      expect(await CheckIn.countDocuments({ inviteeId: g._id })).toBe(checkIns);
      const now: any = await Invitee.findById(g._id).select('+qrTokenCipher').lean();
      const fresh = await scan(B, ev, session, decryptToken(now.qrTokenCipher)!);
      expect(fresh.ok).toBe(!sc.ok);                                          // Only Once: a guest already admitted is not admitted twice
    }
    console.log('replace-vs-scan outcomes', tally);
  });

  it('cancellation against check-in: no attendance is recorded after the cancellation, and the frozen count matches', async () => {
    for (let i = 0; i < 8; i++) {
      const { ev, session } = await mkEvent(); const { g, admission } = await mkGuest(ev);
      const [c, sc] = await Promise.all([A.eventService.cancelEvent(String(ev._id), actor(), 'race'), scan(B, ev, session, admission)]);
      await settle(150);
      const e: any = await Event.findById(ev._id).lean();
      expect(e.status).toBe(EventStatus.CANCELLED);
      const rows: any[] = await CheckIn.find({ eventId: ev._id }).lean();
      expect(rows.length).toBe(sc.ok ? 1 : 0);
      for (const r of rows) expect(+new Date(r.checkInAt)).toBeLessThanOrEqual(+new Date(e.cancelledAt));
      if (e.finalAdmissionSeq !== undefined && e.finalAdmissionSeq !== null) expect(rows.length).toBe(e.finalAdmissionSeq);
      expect((await scan(A, ev, session, admission)).ok).toBe(false);
      expect(await CheckIn.countDocuments({ eventId: ev._id })).toBe(rows.length);
    }
  });

  it('event closure against check-in: the attendance recorded equals the count frozen at closure', async () => {
    for (let i = 0; i < 8; i++) {
      const { ev, session } = await mkEvent();
      const guests = await Promise.all([1, 2, 3, 4].map((k) => mkGuest(ev, `G${k}`)));
      const scans = guests.map((x, k) => scan(k % 2 ? A : B, ev, session, x.admission));
      const [closed, ...res] = await Promise.all([A.eventService.closeEvent(String(ev._id), actor()), ...scans]);
      await settle(150);
      const e: any = await Event.findById(ev._id).lean();
      expect(e.status).toBe(EventStatus.COMPLETED);
      const n = await CheckIn.countDocuments({ eventId: ev._id });
      expect(n).toBe(res.filter((r: any) => r.ok).length);
      expect(n).toBe(e.finalAdmissionSeq);                                    // nobody admitted after the freeze, nobody lost before it
      for (const r of await CheckIn.find({ eventId: ev._id }).lean()) expect(+new Date(r.checkInAt)).toBeLessThanOrEqual(+new Date(e.closedAt));
      expect((await scan(B, ev, session, guests[0].admission)).ok).toBe(false);
    }
  });

  it('restore against Excel import, two instances: one active guest, the archived record intact', async () => {
    for (let i = 0; i < 6; i++) {
      const { ev } = await mkEvent();
      const arch: any = await Invitee.create({ eventId: ev._id, name: 'Draft Dee', email: `dee${i}@x.com`, invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [], archivedAt: new Date(), archivedReason: 'SUPERSEDED_BY_UPLOAD' });
      const [rest, imp] = await Promise.all([
        A.inviteeSetService.restore(actor(), String(ev._id), [String(arch._id)]),
        B.inviteeService.processExcelImport(String(ev._id), String(org._id), sheet([['Name', 'Email'], ['Imported Ivy', `dee${i}@x.com`]]), { role: 'ORGANIZER', mode: 'APPEND', fileName: 'r.xlsx' }).then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, code: e?.code }))
      ]);
      expect(await Invitee.countDocuments({ eventId: ev._id, email: `dee${i}@x.com` })).toBe(1);
      const stored: any = await Invitee.findById(arch._id).setOptions({ includeArchived: true } as any).lean();
      expect(stored.name).toBe('Draft Dee');
      if (rest.results[0].status === 'RESTORED') { expect(stored.archivedAt).toBeNull(); if (!imp.ok) expect(imp.code).toBe(11000); expect(await InviteeSet.countDocuments({ eventId: ev._id })).toBe(imp.ok && imp.r.imported > 0 ? 1 : 0); /* an import that only found the restored guest adds nobody, so it makes no list */ }
      else { expect(rest.results[0].status).toBe('DUPLICATE_ACTIVE'); expect(stored.archivedAt).toBeTruthy(); expect(imp.ok && imp.r.imported).toBe(1); }
    }
  });

  it('duplicate invitee creation from two instances: one wins, by email and by phone written differently', async () => {
    for (let i = 0; i < 6; i++) {
      const { ev } = await mkEvent();
      const make = (inst: Instance, data: any) => inst.inviteeService.createInvitee(String(ev._id), String(org._id), data, 'ORGANIZER').then(() => ({ ok: true }), (e: any) => ({ ok: false, code: e?.code ?? e?.message }));
      const [e1, e2] = await Promise.all([make(A, { name: 'Same Sam', email: `sam${i}@x.com` }), make(B, { name: 'Sam Again', email: `SAM${i}@x.com` })]);
      expect([e1.ok, e2.ok].filter(Boolean)).toHaveLength(1);
      expect(await Invitee.countDocuments({ eventId: ev._id, email: `sam${i}@x.com` })).toBe(1);
      const [p1, p2] = await Promise.all([make(A, { name: 'Pat One', mobile: `98781${10000 + i}` }), make(B, { name: 'Pat Two', mobile: `+91 98781-${10000 + i}` })]);
      expect([p1.ok, p2.ok].filter(Boolean)).toHaveLength(1);
      expect(await Invitee.countDocuments({ eventId: ev._id, mobileKey: `9198781${10000 + i}` })).toBe(1);
    }
  });

  it('notification dispatch races: a message is handed to the provider once, whichever instance runs the notice, including a retry race', async () => {
    for (let i = 0; i < 6; i++) {
      const { ev } = await mkEvent(); const { g } = await mkGuest(ev);
      const ce: any = await CredentialEvent.create({ eventId: ev._id, inviteeId: g._id, organizerId: org._id, type: 'REVOKED', version: 1, source: 'REVOKE', credentialId: g.credentialId, tokenHash: g.qrTokenHash });
      const notice: any = await PassNotice.create({ eventId: ev._id, inviteeId: g._id, organizerId: org._id, credentialEventId: ce._id, kind: 'REVOKED', credentialVersion: 1, email: { status: 'PENDING', attempts: 0 }, whatsapp: { status: 'NOT_USED', attempts: 0 } });
      await Promise.all([A.passNoticeService.processNotice(notice._id), B.passNoticeService.processNotice(notice._id), A.passNoticeService.processNotice(notice._id)]);
      const row: any = await PassNotice.findById(notice._id).lean();
      expect(row.email.status).toBe('SENT');
      expect(row.email.attempts).toBe(1);
      expect(emailCalls.filter((c) => c.to === g.email)).toHaveLength(1);
    }
    // a retry racing a retry
    const { ev } = await mkEvent(); const { g } = await mkGuest(ev);
    const ce: any = await CredentialEvent.create({ eventId: ev._id, inviteeId: g._id, organizerId: org._id, type: 'REVOKED', version: 1, source: 'REVOKE', credentialId: g.credentialId, tokenHash: g.qrTokenHash });
    const notice: any = await PassNotice.create({ eventId: ev._id, inviteeId: g._id, organizerId: org._id, credentialEventId: ce._id, kind: 'REVOKED', credentialVersion: 1, email: { status: 'FAILED', attempts: 1, failureReason: 'provider refused' }, whatsapp: { status: 'NOT_USED', attempts: 0 } });
    emailCalls = [];
    await Promise.all([A.passNoticeService.retry(ev._id), B.passNoticeService.retry(ev._id)]);
    expect(emailCalls.filter((c) => c.to === g.email)).toHaveLength(1);
    expect(((await PassNotice.findById(notice._id).lean()) as any).email.status).toBe('SENT');
  });
});
