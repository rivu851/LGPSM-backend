import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as xlsx from 'xlsx';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventStatus } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation, DeliveryChannel, InvitationDeliveryStatus } from '../src/models/Invitation';
import { CheckIn } from '../src/models/CheckIn';
import { CredentialEvent } from '../src/models/CredentialEvent';
import { InviteeSet } from '../src/models/InviteeSet';
import { AuditLog } from '../src/models/AuditLog';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { inviteeRepository } from '../src/repositories/invitee.repository';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60_000);

let mongo: MongoMemoryServer;
let orgA: any, orgB: any, admin: any, staff: any;
let tA: string, tB: string, tAdmin: string, tStaff: string;
let event: any;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const HEAD = ['Name', 'Email', 'Mobile'];
const sheet = (rows: (string | number)[][]) => {
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'Invitees');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};
const upload = (rows: (string | number)[][], mode: 'REPLACE' | 'APPEND', file = 'list.xlsx', who = tA, ev = event) =>
  request(app).post(`/api/v1/events/${ev._id}/invitees/import`).set(bearer(who)).field('mode', mode).attach('file', sheet(rows), file);
const names = async (ev = event) => (await Invitee.find({ eventId: ev._id }).sort({ name: 1 })).map((i) => i.name);
const sets = async (who = tA, ev = event) => request(app).get(`/api/v1/events/${ev._id}/invitees/sets`).set(bearer(who));
const asideList = (who = tA, ev = event, q = '') => request(app).get(`/api/v1/events/${ev._id}/invitees/set-aside${q}`).set(bearer(who));
const restore = (ids: string[], who = tA, ev = event) => request(app).post(`/api/v1/events/${ev._id}/invitees/set-aside/restore`).set(bearer(who)).send({ inviteeIds: ids });
const byEmail = async (email: string) => Invitee.findOne({ email }).setOptions({ includeArchived: true } as any);
const audit = async (q: Record<string, unknown>) => {
  for (let i = 0; i < 40; i++) { const rows = await AuditLog.find(q).lean(); if (rows.length) return rows as any[]; await new Promise((r) => setTimeout(r, 100)); }
  return [] as any[];
};
const mkEvent = (organizerId: any, extra: Record<string, unknown> = {}) => Event.create({
  organizerId, title: 'Sets', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', status: EventStatus.PUBLISHED,
  schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 864e5 + 8 * 36e5) }, ...extra
} as any);

/** Two lists: "sent.xlsx" gets a successful send, then "draft.xlsx" (never invited) is Replaced -> its guests are set aside. */
async function seedSetAside() {
  await upload([HEAD, ['Sent Sam', 'sam@x.com', ''], ['Sent Sue', 'sue@x.com', '']], 'REPLACE', 'sent.xlsx');
  await Invitee.updateOne({ email: 'sam@x.com' }, { invitationStatus: InvitationStatus.SENT });
  await upload([HEAD, ['Draft Dee', 'dee@x.com', '9876500011'], ['Draft Dan', 'dan@x.com', '']], 'APPEND', 'draft.xlsx');
  const res = await upload([HEAD, ['Fresh Fay', 'fay@x.com', '']], 'REPLACE', 'fresh.xlsx');
  expect(res.body.data.archived).toBe(2);
  return res.body.data;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const mk = (fullName: string, email: string, role: Role) => User.create({ fullName, email, role, isActive: true });
  orgA = await mk('Org A', 'a.sm@x.com', Role.ORGANIZER);
  orgB = await mk('Org B', 'b.sm@x.com', Role.ORGANIZER);
  admin = await mk('Admin', 'admin.sm@x.com', Role.ADMIN);
  staff = await mk('Staff', 'staff.sm@x.com', Role.SYSTEM_USER);
  tA = generateAccessToken(String(orgA._id), Role.ORGANIZER);
  tB = generateAccessToken(String(orgB._id), Role.ORGANIZER);
  tAdmin = generateAccessToken(String(admin._id), Role.ADMIN);
  tStaff = generateAccessToken(String(staff._id), Role.SYSTEM_USER);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([Invitee, Event, InviteeSet, Invitation, CheckIn, CredentialEvent, AuditLog, SystemUserAssignment].map((m: any) => m.deleteMany({})));
  event = await mkEvent(orgA._id);
  await SystemUserAssignment.create({ userId: staff._id, eventId: event._id, sessionIds: [], assignedBy: orgA._id });
});

describe('list state: Open / Locked and the counts behind it', () => {
  const stateOf = async (name: string) => (await sets()).body.data.sets.find((s: any) => s.name === name);

  it('a failed send alone leaves the list Open and counts the failure', async () => {
    await upload([HEAD, ['Fail Fred', 'fred@x.com', ''], ['Idle Ida', 'ida@x.com', '']], 'REPLACE', 'a.xlsx');
    await Invitee.updateOne({ email: 'fred@x.com' }, { invitationStatus: InvitationStatus.FAILED });
    const s = await stateOf('a.xlsx');
    expect(s).toMatchObject({ locked: false, lockReasons: null, total: 2, failed: 1, notSent: 1, sent: 0, unknown: 0 });
  });

  it('a successfully dispatched invitation locks the list, and says why', async () => {
    await upload([HEAD, ['Sent Sam', 'sam@x.com', ''], ['Idle Ida', 'ida@x.com', '']], 'REPLACE', 'a.xlsx');
    await Invitee.updateOne({ email: 'sam@x.com' }, { invitationStatus: InvitationStatus.SENT });
    expect(await stateOf('a.xlsx')).toMatchObject({ locked: true, lockReasons: { sentGuests: 1, answeredRsvp: 0, checkedIn: 0 }, sent: 1, notSent: 1, replaceableGuests: 0 });
  });

  it('a delivery record the provider accepted locks the list even if the guest row was never updated', async () => {
    await upload([HEAD, ['Odd Olga', 'olga@x.com', '']], 'REPLACE', 'a.xlsx');
    const g = await Invitee.findOne({ email: 'olga@x.com' });
    await Invitation.create({ eventId: event._id, inviteeId: g!._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.SENT, tokenHash: 'th' } as any);
    expect(await stateOf('a.xlsx')).toMatchObject({ locked: true, sent: 1, notSent: 0 });
  });

  it('an RSVP locks the list', async () => {
    await upload([HEAD, ['Rita Rsvp', 'rita@x.com', '']], 'REPLACE', 'a.xlsx');
    await Invitee.updateOne({ email: 'rita@x.com' }, { rsvpStatus: RsvpStatus.DECLINED });
    expect(await stateOf('a.xlsx')).toMatchObject({ locked: true, lockReasons: { sentGuests: 0, answeredRsvp: 1, checkedIn: 0 } });
  });

  it('a check-in locks the list', async () => {
    await upload([HEAD, ['Cal Checked', 'cal@x.com', '']], 'REPLACE', 'a.xlsx');
    const g = await Invitee.findOne({ email: 'cal@x.com' });
    await CheckIn.create({ eventId: event._id, inviteeId: g!._id, checkInMethod: 'QR', checkedInBy: orgA._id } as any);
    expect(await stateOf('a.xlsx')).toMatchObject({ locked: true, lockReasons: { sentGuests: 0, answeredRsvp: 0, checkedIn: 1 } });
  });

  it('an unresolved (Unknown) delivery is shown, does not lock the list, and is not counted as failed or never sent', async () => {
    await upload([HEAD, ['Unknown Uma', 'uma@x.com', ''], ['Idle Ida', 'ida@x.com', '']], 'REPLACE', 'a.xlsx');
    const g = await Invitee.findOne({ email: 'uma@x.com' });
    await Invitation.create({ eventId: event._id, inviteeId: g!._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.PENDING, tokenHash: 'th' } as any);
    expect(await stateOf('a.xlsx')).toMatchObject({ locked: false, unknown: 1, failed: 0, notSent: 1, replaceableGuests: 1 });
  });

  it('reports who uploaded it, how, when, how many were added, and how many guests were set aside', async () => {
    await seedSetAside();
    const all = (await sets()).body.data;
    const draft = all.sets.find((s: any) => s.name === 'draft.xlsx');
    expect(draft).toMatchObject({ mode: 'APPEND', source: 'EXCEL', total: 0, setAside: 2, importedCount: 2, locked: false });
    expect(draft.uploadedBy).toMatchObject({ name: 'Org A' });
    expect(new Date(draft.createdAt).getTime()).toBeGreaterThan(0);
    expect(all.archivedCount).toBe(2);
    const sent = all.sets.find((s: any) => s.name === 'sent.xlsx');
    expect(sent).toMatchObject({ locked: true, total: 2, sent: 1, notSent: 1 });
  });

  it('lists the guests of one list with their delivery state, and exposes no tokens', async () => {
    await upload([HEAD, ['Sent Sam', 'sam@x.com', ''], ['Idle Ida', 'ida@x.com', '']], 'REPLACE', 'a.xlsx');
    await Invitee.updateOne({ email: 'sam@x.com' }, { invitationStatus: InvitationStatus.SENT, qrTokenHash: 'secret-hash' });
    const id = (await stateOf('a.xlsx')).id;
    const res = await request(app).get(`/api/v1/events/${event._id}/invitees/sets/${id}/members`).set(bearer(tA));
    expect(res.status).toBe(200);
    expect(res.body.data.members.map((m: any) => [m.name, m.delivery])).toEqual([['Idle Ida', 'NOT_SENT'], ['Sent Sam', 'SENT']]);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-hash|qrToken|tokenHash|cipher/i);
  });
});

describe('Replace keeps everything that was attempted, and a failed Replace changes nothing', () => {
  it('never sets aside a guest whose delivery outcome is unknown, nor a failed one, and reports both', async () => {
    await upload([HEAD, ['Unknown Uma', 'uma@x.com', ''], ['Fail Fred', 'fred@x.com', ''], ['Idle Ida', 'ida@x.com', '']], 'REPLACE', 'a.xlsx');
    const uma = await Invitee.findOne({ email: 'uma@x.com' });
    await Invitation.create({ eventId: event._id, inviteeId: uma!._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.PENDING, tokenHash: 'th' } as any);
    await Invitee.updateOne({ email: 'fred@x.com' }, { invitationStatus: InvitationStatus.FAILED });
    const res = await upload([HEAD, ['New Nat', 'nat@x.com', '']], 'REPLACE', 'b.xlsx');
    expect(res.body.data).toMatchObject({ archived: 1, failedKept: 1, unknownKept: 1 });
    expect(await names()).toEqual(['Fail Fred', 'New Nat', 'Unknown Uma']);
  });

  it('a guest with only an access pass or an unmatched delivery row is "attempted" and is kept', async () => {
    await upload([HEAD, ['Pass Pam', 'pam@x.com', '']], 'REPLACE', 'a.xlsx');
    await Invitee.updateOne({ email: 'pam@x.com' }, { qrTokenHash: 'h' });
    const res = await upload([HEAD, ['New Nat', 'nat@x.com', '']], 'REPLACE', 'b.xlsx');
    expect(res.body.data.archived).toBe(0);
    expect(await names()).toEqual(['New Nat', 'Pass Pam']);
  });

  it('when every guest of a list failed, the whole list stays and the new file becomes a separate list', async () => {
    await upload([HEAD, ['Fail One', 'f1@x.com', ''], ['Fail Two', 'f2@x.com', '']], 'REPLACE', 'a.xlsx');
    await Invitee.updateMany({}, { invitationStatus: InvitationStatus.FAILED });
    const res = await upload([HEAD, ['New Nat', 'nat@x.com', '']], 'REPLACE', 'b.xlsx');
    expect(res.body.data).toMatchObject({ archived: 0, failedKept: 2, imported: 1 });
    const s = (await sets()).body.data.sets;
    expect(s.map((x: any) => [x.name, x.total, x.locked])).toEqual([['a.xlsx', 2, false], ['b.xlsx', 1, false]]);
    expect(s[0].failed).toBe(2);
  });

  it('a locked list keeps even its not-yet-sent guests; a new list can still be added next to it', async () => {
    await upload([HEAD, ['Sent Sam', 'sam@x.com', ''], ['Idle Ida', 'ida@x.com', '']], 'REPLACE', 'a.xlsx');
    await Invitee.updateOne({ email: 'sam@x.com' }, { invitationStatus: InvitationStatus.SENT });
    const res = await upload([HEAD, ['New Nat', 'nat@x.com', '']], 'REPLACE', 'b.xlsx');
    expect(res.body.data).toMatchObject({ archived: 0, preservedSets: 1, imported: 1 });
    expect(await names()).toEqual(['Idle Ida', 'New Nat', 'Sent Sam']);
  });

  it('an upload that fails while inserting leaves the event exactly as it was', async () => {
    await upload([HEAD, ['Old Olga', 'olga@x.com', '']], 'REPLACE', 'a.xlsx');
    jest.spyOn(inviteeRepository, 'insertMany').mockRejectedValueOnce(new Error('disk full'));
    const res = await upload([HEAD, ['New Nat', 'nat@x.com', '']], 'REPLACE', 'b.xlsx');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await names()).toEqual(['Old Olga']);
    expect(await InviteeSet.countDocuments({ eventId: event._id })).toBe(1);
    expect(await Invitee.countDocuments({ archivedAt: { $ne: null } }).setOptions({ includeArchived: true } as any)).toBe(0);
  });

  it('an upload that fails while setting guests aside is rolled back: nobody archived, no half-made list', async () => {
    await upload([HEAD, ['Old Olga', 'olga@x.com', '']], 'REPLACE', 'a.xlsx');
    const real = Invitee.updateMany.bind(Invitee);
    let calls = 0;
    jest.spyOn(Invitee, 'updateMany').mockImplementation(((...args: any[]) => (++calls === 1 ? Promise.reject(new Error('connection lost')) : (real as any)(...args))) as any);
    const res = await upload([HEAD, ['New Nat', 'nat@x.com', '']], 'REPLACE', 'b.xlsx');
    expect(res.status).toBeGreaterThanOrEqual(500);
    jest.restoreAllMocks();
    expect(await names()).toEqual(['Old Olga']);
    expect(await InviteeSet.countDocuments({ eventId: event._id })).toBe(1);
  });
});

describe('set-aside guests: who can see them', () => {
  it('the owner sees them apart from the active list, with list, date, reason and actor', async () => {
    await seedSetAside();
    expect(await names()).toEqual(['Fresh Fay', 'Sent Sam', 'Sent Sue']);
    const res = await asideList();
    expect(res.status).toBe(200);
    const g = res.body.data.guests.find((x: any) => x.name === 'Draft Dee');
    expect(g).toMatchObject({ email: 'dee@x.com', fromSet: { name: 'draft.xlsx' }, reason: 'SUPERSEDED_BY_UPLOAD', replacedBy: { name: 'fresh.xlsx' }, setAsideBy: { name: 'Org A', role: 'ORGANIZER' } });
    expect(new Date(g.setAsideAt).getTime()).toBeGreaterThan(0);
    expect(res.body.data).toMatchObject({ total: 2, restorable: true });
    expect(JSON.stringify(res.body)).not.toMatch(/qrToken|tokenHash|cipher|password/i);
  });

  it('can be searched, and is paged', async () => {
    await seedSetAside();
    expect((await asideList(tA, event, '?q=dan')).body.data.guests.map((g: any) => g.name)).toEqual(['Draft Dan']);
    expect((await asideList(tA, event, '?limit=1&page=2')).body.data.guests).toHaveLength(1);
  });

  it('another organizer cannot see them', async () => {
    await seedSetAside();
    expect([403, 404]).toContain((await asideList(tB)).status);
    expect([403, 404]).toContain((await sets(tB)).status);
  });

  it('an administrator can see them on any event', async () => {
    await seedSetAside();
    const res = await asideList(tAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect((await sets(tAdmin)).status).toBe(200);
  });

  it('a System User, even one assigned to the event, is refused every set endpoint', async () => {
    await seedSetAside();
    const g = await byEmail('dee@x.com');
    const setId = (await InviteeSet.findOne({ name: 'sent.xlsx' }))!._id;
    expect((await asideList(tStaff)).status).toBe(403);
    expect((await restore([String(g!._id)], tStaff)).status).toBe(403);
    expect((await sets(tStaff)).status).toBe(403);
    expect((await request(app).get(`/api/v1/events/${event._id}/invitees/sets/${setId}/members`).set(bearer(tStaff))).status).toBe(403);
    expect((await byEmail('dee@x.com'))!.archivedAt).toBeTruthy();
  });

  it('refuses a request with no sign-in', async () => {
    expect((await request(app).get(`/api/v1/events/${event._id}/invitees/set-aside`)).status).toBe(401);
  });
});

describe('restoring set-aside guests', () => {
  it('brings back the same record, in its original list, Not Sent, with no invitation or pass, and keeps the history', async () => {
    await seedSetAside();
    const before: any = await byEmail('dee@x.com');
    const res = await restore([String(before._id)]);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ restored: 1, refused: 0 });
    const after: any = await Invitee.findById(before._id); // visible through the normal (active) query again
    expect(String(after._id)).toBe(String(before._id));
    expect(String(after.inviteeSetId)).toBe(String(before.inviteeSetId));
    expect(after).toMatchObject({ invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, name: 'Draft Dee', email: 'dee@x.com', archivedAt: null });
    expect(after.restoredAt).toBeTruthy();
    expect(String(after.restoredBy)).toBe(String(orgA._id));
    expect(after.qrTokenHash).toBeFalsy();
    expect(after.setAsideHistory).toHaveLength(1);
    expect(after.setAsideHistory[0]).toMatchObject({ reason: 'SUPERSEDED_BY_UPLOAD' });
    expect(String(after.setAsideHistory[0].archivedBy)).toBe(String(orgA._id));
    expect(await Invitation.countDocuments({ inviteeId: before._id })).toBe(0);
    expect(await CredentialEvent.countDocuments({ inviteeId: before._id })).toBe(0);
    expect(await Invitee.countDocuments({ email: 'dee@x.com' }).setOptions({ includeArchived: true } as any)).toBe(1); // no duplicate record
    expect(await names()).toEqual(['Draft Dee', 'Fresh Fay', 'Sent Sam', 'Sent Sue']);
    expect((await asideList()).body.data.total).toBe(1);
  });

  it('a restored guest is an ordinary unsent guest again: the next Replace can set them aside again', async () => {
    await seedSetAside();
    const g: any = await byEmail('dee@x.com');
    await restore([String(g._id)]);
    const res = await upload([HEAD, ['Other Oz', 'oz@x.com', '']], 'REPLACE', 'next.xlsx');
    expect(res.body.data.archived).toBeGreaterThanOrEqual(1);
    const again: any = await byEmail('dee@x.com');
    expect(again.archivedAt).toBeTruthy();
    expect(again.setAsideHistory).toHaveLength(1);
  });

  it('is refused when an active guest has the same email, and the archived record is left untouched', async () => {
    await seedSetAside();
    await Invitee.create({ eventId: event._id, name: 'Someone Else', email: 'DEE@x.com', invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [] });
    const g: any = await byEmail('dee@x.com');
    const snapshot = JSON.stringify(await Invitee.findById(g._id).setOptions({ includeArchived: true } as any).lean());
    const res = await restore([String(g._id)]);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ restored: 0, refused: 1 });
    expect(res.body.data.results[0]).toMatchObject({ status: 'DUPLICATE_ACTIVE', conflictsWith: { name: 'Someone Else', matchedOn: 'email' } });
    expect(JSON.stringify(await Invitee.findById(g._id).setOptions({ includeArchived: true } as any).lean())).toBe(snapshot);
  });

  it('is refused when an active guest has the same phone number in another format', async () => {
    await seedSetAside();
    await Invitee.create({ eventId: event._id, name: 'Phone Pat', mobile: '+91 98765 00011', invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [] });
    const g: any = await byEmail('dee@x.com');
    const res = await restore([String(g._id)]);
    expect(res.body.data.results[0]).toMatchObject({ status: 'DUPLICATE_ACTIVE', conflictsWith: { name: 'Phone Pat', matchedOn: 'mobile' } });
  });

  it('is NOT refused because of a name alone', async () => {
    await seedSetAside();
    await Invitee.create({ eventId: event._id, name: 'Draft Dee', email: 'different@x.com', invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [] });
    const g: any = await byEmail('dee@x.com');
    expect((await restore([String(g._id)])).body.data.restored).toBe(1);
  });

  it.each([
    ['cancelled', { status: EventStatus.CANCELLED }],
    ['completed', { status: EventStatus.COMPLETED }],
    ['closed', { closedAt: new Date() }]
  ])('is refused for a %s event, and the list says so', async (_label, patch) => {
    await seedSetAside();
    const g: any = await byEmail('dee@x.com');
    await Event.updateOne({ _id: event._id }, patch);
    const res = await restore([String(g._id)]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVENT_NOT_ACTIVE');
    expect((await byEmail('dee@x.com'))!.archivedAt).toBeTruthy();
    const list = await asideList();
    expect(list.body.data).toMatchObject({ restorable: false });
    expect(list.body.data.notRestorableReason).toMatch(/cannot be restored/);
  });

  it('another organizer, a System User and a missing sign-in cannot restore; an admin can', async () => {
    await seedSetAside();
    const g: any = await byEmail('dee@x.com');
    expect([403, 404]).toContain((await restore([String(g._id)], tB)).status);
    expect((await restore([String(g._id)], tStaff)).status).toBe(403);
    expect((await byEmail('dee@x.com'))!.archivedAt).toBeTruthy();
    const ok = await restore([String(g._id)], tAdmin);
    expect(ok.body.data.restored).toBe(1);
  });

  it('is idempotent: restoring again reports "already active" and changes nothing further', async () => {
    await seedSetAside();
    const g: any = await byEmail('dee@x.com');
    await restore([String(g._id)]);
    const again = await restore([String(g._id)]);
    expect(again.body.data).toMatchObject({ restored: 0, alreadyActive: 1 });
    expect((await Invitee.findById(g._id) as any).setAsideHistory).toHaveLength(1);
  });

  it('reports each guest of a bulk restore on its own, and rejects bad input', async () => {
    await seedSetAside();
    const dee: any = await byEmail('dee@x.com'), dan: any = await byEmail('dan@x.com');
    await Invitee.create({ eventId: event._id, name: 'Rival', email: 'dan@x.com', invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [] });
    const res = await restore([String(dee._id), String(dan._id), String(new mongoose.Types.ObjectId())]);
    expect(res.body.data).toMatchObject({ restored: 1, refused: 1, notFound: 1 });
    expect((await restore([])).status).toBe(400);
    expect((await restore(['not-an-id'])).status).toBe(400);
  });

  it('two simultaneous restores of the same guest restore exactly once', async () => {
    await seedSetAside();
    const g: any = await byEmail('dee@x.com');
    const [a, b] = await Promise.all([restore([String(g._id)]), restore([String(g._id)])]);
    expect(a.body.data.restored + b.body.data.restored).toBe(1);
    expect(await Invitee.countDocuments({ email: 'dee@x.com' }).setOptions({ includeArchived: true } as any)).toBe(1);
    expect(((await Invitee.findById(g._id)) as any).setAsideHistory).toHaveLength(1);
  });

  it('a restore and an upload of the same person at the same moment never leave two active copies', async () => {
    await seedSetAside();
    const g: any = await byEmail('dee@x.com');
    await Promise.all([restore([String(g._id)]), upload([HEAD, ['Draft Dee', 'dee@x.com', '']], 'APPEND', 'again.xlsx')]);
    expect(await Invitee.countDocuments({ eventId: event._id, email: 'dee@x.com' })).toBe(1);
  });
});

describe('audit entries', () => {
  it('records who set guests aside, with counts, and who restored them, without personal details or secrets', async () => {
    const r = await seedSetAside();
    const aside = (await audit({ action: 'INVITEE_SET_ASIDE', eventId: event._id }))[0];
    expect(aside).toMatchObject({ actorType: 'ORGANIZER', status: 'SUCCESS' });
    expect(String(aside.actorId)).toBe(String(orgA._id));
    expect(aside.metadata).toMatchObject({ setId: r.setId, mode: 'REPLACE', archived: 2, preservedSets: 1 });

    const g: any = await byEmail('dee@x.com');
    await restore([String(g._id)], tAdmin);
    const one = (await audit({ action: 'INVITEE_RESTORED', entityId: g._id }))[0];
    expect(one).toMatchObject({ actorType: 'ADMIN', status: 'SUCCESS' });
    expect(String(one.actorId)).toBe(String(admin._id));
    expect(String(one.eventId)).toBe(String(event._id));
    expect(String(one.organizerId)).toBe(String(orgA._id));
    expect(one.metadata).toMatchObject({ reason: 'SUPERSEDED_BY_UPLOAD' });
    const summary = (await audit({ action: 'INVITEE_RESTORE', eventId: event._id }))[0];
    expect(summary.metadata).toMatchObject({ restored: 1, refused: 0 });
    const everything = JSON.stringify(await AuditLog.find({ eventId: event._id }).lean());
    expect(everything).not.toMatch(/dee@x\.com|9876500011|Draft Dee|tokenHash|secret|password/i);
  });

  it('records a refused restoration as a failed entry naming the conflict, not the person', async () => {
    await seedSetAside();
    const archived: any = await byEmail('dee@x.com');
    const rival = await Invitee.create({ eventId: event._id, name: 'Rival', email: 'dee@x.com', invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [] });
    await restore([String(archived._id)]);
    const row = (await audit({ action: 'INVITEE_RESTORE_CONFLICT', eventId: event._id }))[0];
    expect(row).toMatchObject({ status: 'FAILED', actorType: 'ORGANIZER' });
    expect(row.metadata).toMatchObject({ reason: 'DUPLICATE_ACTIVE', matchedOn: 'email', conflictingInviteeId: String(rival._id) });
    expect(JSON.stringify(row)).not.toMatch(/dee@x\.com/);
  });

  it('keeps tenants apart: another organizer sees none of this event\'s entries', async () => {
    await seedSetAside();
    await audit({ action: 'INVITEE_SET_ASIDE', eventId: event._id });
    const res = await request(app).get(`/api/v1/audit-logs?eventId=${event._id}`).set(bearer(tB));
    expect([200, 403, 404]).toContain(res.status);
    if (res.status === 200) expect(res.body.data).toHaveLength(0);
  });
});

describe('a Locked list is not rewritten', () => {
  it('refuses to change the details of, or remove, a guest of a locked uploaded list', async () => {
    await upload([HEAD, ['Sent Sam', 'sam@x.com', ''], ['Idle Ida', 'ida@x.com', '']], 'REPLACE', 'a.xlsx');
    await Invitee.updateOne({ email: 'sam@x.com' }, { invitationStatus: InvitationStatus.SENT });
    const ida: any = await Invitee.findOne({ email: 'ida@x.com' });
    const patch = await request(app).patch(`/api/v1/invitees/${ida._id}`).set(bearer(tA)).send({ name: 'Renamed Ida' });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe('SET_LOCKED');
    const del = await request(app).delete(`/api/v1/invitees/${ida._id}`).set(bearer(tA));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('SET_LOCKED');
    expect((await Invitee.findById(ida._id))!.name).toBe('Idle Ida');
  });

  it('never lets the organizer set the guest\'s food choice (the guest makes it on the invitation page) and still adds a brand new list', async () => {
    await upload([HEAD, ['Sent Sam', 'sam@x.com', '']], 'REPLACE', 'a.xlsx');
    await Invitee.updateOne({ email: 'sam@x.com' }, { invitationStatus: InvitationStatus.SENT });
    const sam: any = await Invitee.findOne({ email: 'sam@x.com' });
    expect((await request(app).patch(`/api/v1/invitees/${sam._id}`).set(bearer(tA)).send({ dietaryPreference: 'Veg' })).status).toBe(200);
    expect((await Invitee.findById(sam._id))!.dietaryPreference).toBeUndefined();
    expect((await upload([HEAD, ['New Nat', 'nat@x.com', '']], 'APPEND', 'b.xlsx')).body.data.imported).toBe(1);
  });

  it('never removes a guest who was invited, answered or attended, even from an open or hand-made list', async () => {
    const hand: any = await Invitee.create({ eventId: event._id, name: 'Hand Hal', email: 'hal@x.com', invitationStatus: InvitationStatus.FAILED, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [] });
    const del = await request(app).delete(`/api/v1/invitees/${hand._id}`).set(bearer(tA));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('HAS_HISTORY');
    const fresh: any = await Invitee.create({ eventId: event._id, name: 'Hand Hana', email: 'hana@x.com', invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [] });
    expect((await request(app).delete(`/api/v1/invitees/${fresh._id}`).set(bearer(tA))).status).toBe(200);
    expect((await request(app).patch(`/api/v1/invitees/${hand._id}`).set(bearer(tA)).send({ name: 'Hand Hal Renamed' })).status).toBe(200); // hand-made list: details stay editable
  });
});
