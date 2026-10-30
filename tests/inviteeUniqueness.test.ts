import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as xlsx from 'xlsx';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventStatus } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { InviteeSet } from '../src/models/InviteeSet';
import { AuditLog } from '../src/models/AuditLog';
import { inviteeRepository } from '../src/repositories/invitee.repository';
import { inviteeSetService } from '../src/services/inviteeSet.service';
import { analyzeInviteeUniqueness, applyInviteeUniqueness } from '../src/migrations/inviteeUniqueness';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60_000);

let mongo: MongoMemoryServer;
let org: any, tok: string, event: any, event2: any;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sheet = (rows: (string | number)[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'I'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };
const upload = (rows: (string | number)[][], mode: 'REPLACE' | 'APPEND', extra: Record<string, string> = {}) => {
  const r = request(app).post(`/api/v1/events/${event._id}/invitees/import`).set(bearer(tok)).field('mode', mode);
  for (const [k, v] of Object.entries(extra)) r.field(k, v);
  return r.attach('file', sheet(rows), 'f.xlsx');
};
const mk = (extra: Record<string, unknown>, ev = event) => Invitee.create({ eventId: ev._id, name: 'Guest', invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [], ...extra });
const mkEvent = (extra: Record<string, unknown> = {}) => Event.create({ organizerId: org._id, title: 'U', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', status: EventStatus.PUBLISHED, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 864e5 + 36e5) }, ...extra } as any);
const dupKey = (p: Promise<unknown>) => p.then(() => null, (e: any) => e?.code);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Invitee.init(); // the unique indexes exist before any test writes
  org = await User.create({ fullName: 'Org', email: 'org.uq@x.com', role: Role.ORGANIZER, isActive: true });
  tok = generateAccessToken(String(org._id), Role.ORGANIZER);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([Invitee, Event, InviteeSet, AuditLog].map((m: any) => m.deleteMany({})));
  event = await mkEvent(); event2 = await mkEvent();
});

describe('partial unique indexes on active guests', () => {
  it('are in place, keyed on the real archive field', async () => {
    const idx: any[] = await Invitee.collection.indexes();
    const email = idx.find((i) => i.name === 'uniq_active_event_email');
    const mobile = idx.find((i) => i.name === 'uniq_active_event_mobile');
    expect(email).toMatchObject({ unique: true, key: { email: 1, eventId: 1 } });
    expect(mobile).toMatchObject({ unique: true, key: { mobileKey: 1, eventId: 1 } });
    expect(JSON.stringify(email.partialFilterExpression)).toContain('archivedAt');
    expect(JSON.stringify(mobile.partialFilterExpression)).toContain('archivedAt');
  });

  it('refuse a second active guest with the same email in one event, whatever the letter case', async () => {
    await mk({ email: 'dup@x.com' });
    expect(await dupKey(mk({ email: 'DUP@x.com' }))).toBe(11000);
  });

  it('refuse a second active guest with the same phone in one event, however it is written', async () => {
    await mk({ mobile: '9876500001' });
    expect(await dupKey(mk({ mobile: '+91 98765-00001' }))).toBe(11000);
    expect(await dupKey(mk({ mobile: '09876500001' }))).toBe(11000);
  });

  it('allow the same email and phone in a different event', async () => {
    await mk({ email: 'same@x.com', mobile: '9876500001' });
    await expect(mk({ email: 'same@x.com', mobile: '9876500001' }, event2)).resolves.toBeTruthy();
  });

  it('are not occupied by set-aside guests: archived guests may share a contact with each other and with an active guest', async () => {
    await mk({ email: 'a@x.com', mobile: '9876500002', archivedAt: new Date() });
    await mk({ email: 'a@x.com', mobile: '9876500002', archivedAt: new Date() });
    await expect(mk({ email: 'a@x.com', mobile: '9876500002' })).resolves.toBeTruthy();
    await expect(mk({ email: 'a@x.com', mobile: '9876500002', archivedAt: new Date() })).resolves.toBeTruthy();
  });

  it('ignore guests with no email, no phone, an empty email, or a phone with no digits', async () => {
    await mk({}); await mk({}); await mk({ email: '' }); await mk({ email: '' }); await mk({ mobile: '---' }); await mk({ mobile: '---' });
    expect(await Invitee.countDocuments({ eventId: event._id })).toBe(6);
  });

  it('derive the comparison phone key on every save', async () => {
    const g: any = await mk({ mobile: '9876500003' });
    expect((await Invitee.findById(g._id).select('+mobileKey').lean() as any).mobileKey).toBe('919876500003');
    g.mobile = '9876500004'; await g.save();
    expect((await Invitee.findById(g._id).select('+mobileKey').lean() as any).mobileKey).toBe('919876500004');
  });
});

describe('duplicate-key conflicts reach the API as clear 409s', () => {
  const post = (body: object) => request(app).post(`/api/v1/events/${event._id}/invitees`).set(bearer(tok)).send(body);

  it('adding a guest by hand with an existing email or phone', async () => {
    await mk({ email: 'e@x.com', mobile: '9876500005' });
    const a = await post({ name: 'Other One', email: 'e@x.com' });
    const b = await post({ name: 'Other Two', mobile: '+91 98765 00005' });
    expect(a.status).toBe(409); expect(b.status).toBe(409);
  });

  it('editing a guest to a phone another active guest already has (written differently)', async () => {
    await mk({ mobile: '9876500006' });
    const other: any = await mk({ email: 'o@x.com' });
    const res = await request(app).patch(`/api/v1/invitees/${other._id}`).set(bearer(tok)).send({ mobile: '+91 98765 00006' });
    expect(res.status).toBe(409);
    expect((await Invitee.findById(other._id))!.mobile).toBeUndefined();
  });

  it('an import that loses a race to another writer is rolled back whole and answered with a conflict', async () => {
    await mk({ name: 'Old Olga', email: 'olga@x.com' });
    const real = inviteeRepository.insertMany.bind(inviteeRepository);
    // another instance adds this person after this import has done its duplicate checks and before it writes
    jest.spyOn(inviteeRepository, 'insertMany').mockImplementationOnce(async (rows: any) => { await Invitee.collection.insertOne({ eventId: event._id, name: 'Racer', email: rows[rows.length - 1].email, archivedAt: null, invitationStatus: 'PENDING', rsvpStatus: 'PENDING', sessionAccess: [] } as any); return real(rows); });
    const res = await upload([['Name', 'Email'], ['Fresh Fay', 'fay@x.com'], ['Late Lou', 'lou@x.com']], 'REPLACE');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IMPORT_CONFLICT');
    expect(await InviteeSet.countDocuments({ eventId: event._id })).toBe(0);
    const left = (await Invitee.find({ eventId: event._id }).sort({ name: 1 })).map((g) => g.name);
    expect(left).toEqual(['Old Olga', 'Racer']); // nobody from the failed import, nobody set aside
  });
});

describe('restoring is decided by the database, not only by the check before it', () => {
  it('a rival that appears between the check and the write is refused with a controlled conflict, and the archived record is untouched', async () => {
    const archived: any = await mk({ name: 'Draft Dee', email: 'dee@x.com', archivedAt: new Date(), archivedReason: 'SUPERSEDED_BY_UPLOAD' });
    const realUpdate = Invitee.updateOne.bind(Invitee);
    jest.spyOn(Invitee, 'updateOne').mockImplementationOnce(((...args: any[]) =>
      Invitee.collection.insertOne({ eventId: event._id, name: 'Rival', email: 'dee@x.com', archivedAt: null, invitationStatus: 'PENDING', rsvpStatus: 'PENDING', sessionAccess: [] } as any).then(() => (realUpdate as any)(...args))) as any);
    const res = await inviteeSetService.restore({ userId: String(org._id), role: 'ORGANIZER' }, String(event._id), [String(archived._id)]);
    expect(res).toMatchObject({ restored: 0, refused: 1 });
    expect(res.results[0]).toMatchObject({ status: 'DUPLICATE_ACTIVE', conflictsWith: { name: 'Rival', matchedOn: 'email' } });
    const after: any = await Invitee.findById(archived._id).setOptions({ includeArchived: true } as any).lean();
    expect(after.archivedAt).toBeTruthy();
    expect(after.setAsideHistory).toBeUndefined();
    expect(await Invitee.countDocuments({ eventId: event._id, email: 'dee@x.com' })).toBe(1);
    const row = await AuditLog.findOne({ action: 'INVITEE_RESTORE_CONFLICT' }).lean() as any;
    expect(row?.metadata).toMatchObject({ enforcedBy: 'database', matchedOn: 'email' });
  });

  it('two set-aside guests with the same contact cannot both be restored', async () => {
    const a: any = await mk({ name: 'Dee One', email: 'twin@x.com', archivedAt: new Date() });
    const b: any = await mk({ name: 'Dee Two', email: 'twin@x.com', archivedAt: new Date() });
    const actor = { userId: String(org._id), role: 'ORGANIZER' };
    const [r1, r2] = await Promise.all([inviteeSetService.restore(actor, String(event._id), [String(a._id)]), inviteeSetService.restore(actor, String(event._id), [String(b._id)])]);
    expect(r1.restored + r2.restored).toBe(1);
    expect(await Invitee.countDocuments({ eventId: event._id, email: 'twin@x.com' })).toBe(1);
    expect(await Invitee.countDocuments({ eventId: event._id, email: 'twin@x.com' }).setOptions({ includeArchived: true } as any)).toBe(2);
  });
});

describe('index migration: report conflicts first, never choose a winner', () => {
  const legacy = (extra: Record<string, unknown>, ev = event) => Invitee.collection.insertOne({ eventId: ev._id, name: 'Legacy', invitationStatus: 'PENDING', rsvpStatus: 'PENDING', sessionAccess: [], createdAt: new Date(), updatedAt: new Date(), ...extra } as any);

  it('lists duplicate active guests (masked), leaves every record alone, and refuses to build the indexes', async () => {
    await legacy({ email: 'dup@x.com', mobile: '9876500010' });
    await legacy({ email: 'dup@x.com', mobile: '98765 00011' });
    await legacy({ email: 'x@x.com', mobile: '+91 98765 00012' });
    await legacy({ email: 'y@x.com', mobile: '9876500012' });
    await legacy({ email: 'dup@x.com' }, event2); // another event: not a conflict
    const before = JSON.stringify(await Invitee.collection.find({}).sort({ _id: 1 }).toArray());
    const report = await analyzeInviteeUniqueness();
    expect(report.activeGuests).toBe(5);
    expect(report.conflicts.map((c) => c.type).sort()).toEqual(['EMAIL', 'MOBILE']);
    expect(report.conflicts.find((c) => c.type === 'EMAIL')!.guests).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain('dup@x.com'); // masked
    const res = await applyInviteeUniqueness();
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/must be reconciled first/);
    expect(JSON.stringify(await Invitee.collection.find({}).sort({ _id: 1 }).toArray())).toBe(before);
  });

  it('counts archived guests as no conflict, and once clean it backfills the two derived fields and builds the indexes', async () => {
    await legacy({ email: 'dup@x.com', mobile: '9876500010' });
    await legacy({ email: 'dup@x.com', mobile: '9876500010', archivedAt: new Date() });
    const report = await analyzeInviteeUniqueness();
    expect(report.conflicts).toHaveLength(0);
    expect(report).toMatchObject({ needArchivedAtField: 1, needMobileKey: 1 });
    const res = await applyInviteeUniqueness();
    expect(res).toMatchObject({ applied: true, archivedAtBackfilled: 1, mobileKeysSet: 2 });
    expect(res.indexes).toEqual(expect.arrayContaining(['uniq_active_event_email', 'uniq_active_event_mobile']));
    const g: any = await Invitee.collection.findOne({ archivedAt: null });
    expect(g.mobileKey).toBe('919876500010');
    expect(await dupKey(mk({ email: 'dup@x.com' }))).toBe(11000); // now protected
    expect((await analyzeInviteeUniqueness()).needArchivedAtField).toBe(0);
  });
});
