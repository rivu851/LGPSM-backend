import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as xlsx from 'xlsx';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation, DeliveryChannel, InvitationDeliveryStatus } from '../src/models/Invitation';
import { CheckIn } from '../src/models/CheckIn';
import { CredentialEvent } from '../src/models/CredentialEvent';
import { InviteeSet } from '../src/models/InviteeSet';
import { generateAccessToken } from '../src/utils/token';

let mongo: MongoMemoryServer;
let org: any, tok: string, event: any;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sheet = (rows: (string | number)[][]) => {
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'Invitees');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};
const upload = (rows: (string | number)[][], mode?: 'REPLACE' | 'APPEND', file = 'list.xlsx') => {
  const r = request(app).post(`/api/v1/events/${event._id}/invitees/import`).set(bearer(tok));
  if (mode) r.field('mode', mode);
  return r.attach('file', sheet(rows), file);
};
const names = async () => (await Invitee.find({ eventId: event._id }).sort({ name: 1 })).map((i) => i.name);
const HEAD = ['Name', 'Email', 'Mobile'];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  org = await User.create({ fullName: 'Org', email: 'org.sets@example.com', role: Role.ORGANIZER });
  tok = generateAccessToken(String(org._id), Role.ORGANIZER);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([Invitee, Event, InviteeSet, Invitation, CheckIn, CredentialEvent].map((m: any) => m.deleteMany({})));
  const start = new Date(Date.now() + 864e5);
  event = await Event.create({ organizerId: org._id, title: 'Sets', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', schedule: { start, end: new Date(+start + 8 * 36e5) } });
});

describe('invitee lists: Replace and Append', () => {
  it('Replace with a wholly unsent list archives the old guests (kept in the database) and imports the new file as its own list', async () => {
    await upload([HEAD, ['Ann One', 'ann@x.com', ''], ['Ben Two', 'ben@x.com', '']], 'REPLACE', 'first.xlsx');
    const res = await upload([HEAD, ['Cara Three', 'cara@x.com', '']], 'REPLACE', 'second.xlsx');
    expect(res.body.data).toMatchObject({ imported: 1, archived: 2, preservedSets: 0, mode: 'REPLACE' });
    expect(await names()).toEqual(['Cara Three']);
    const kept = await Invitee.find({ eventId: event._id, archivedAt: { $ne: null } }).setOptions({ includeArchived: true });
    expect(kept.map((i) => i.name).sort()).toEqual(['Ann One', 'Ben Two']);
    expect(kept.every((i) => i.archivedReason === 'SUPERSEDED_BY_UPLOAD' && String(i.supersededBySetId) === res.body.data.setId)).toBe(true);
    expect((await InviteeSet.find({ eventId: event._id })).map((s) => s.name).sort()).toEqual(['first.xlsx', 'second.xlsx']);
  });

  it('Replace never removes a list that has been sent, even when its guests are missing from the new file', async () => {
    await upload([HEAD, ['Sent Sam', 'sam@x.com', ''], ['Sent Sue', 'sue@x.com', '']], 'APPEND', 'sent.xlsx');
    await Invitee.updateMany({}, { invitationStatus: InvitationStatus.SENT });
    const res = await upload([HEAD, ['Fresh Fay', 'fay@x.com', '']], 'REPLACE', 'new.xlsx');
    expect(res.body.data).toMatchObject({ imported: 1, archived: 0, preservedSets: 1 });
    expect(await names()).toEqual(['Fresh Fay', 'Sent Sam', 'Sent Sue']);
  });

  it('a partially dispatched list is preserved whole: its unsent members stay, and failed sends stay for retry', async () => {
    await upload([HEAD, ['Sent One', 'one@x.com', ''], ['Pending Two', 'two@x.com', ''], ['Failed Three', 'three@x.com', '']], 'REPLACE', 'mixed.xlsx');
    await Invitee.updateOne({ email: 'one@x.com' }, { invitationStatus: InvitationStatus.SENT });
    await Invitee.updateOne({ email: 'three@x.com' }, { invitationStatus: InvitationStatus.FAILED });
    const res = await upload([HEAD, ['Brand New', 'new@x.com', '']], 'REPLACE', 'next.xlsx');
    expect(res.body.data).toMatchObject({ imported: 1, archived: 0, preservedSets: 1 });
    expect(await names()).toEqual(['Brand New', 'Failed Three', 'Pending Two', 'Sent One']);
    expect((await Invitee.findOne({ email: 'three@x.com' }))?.invitationStatus).toBe(InvitationStatus.FAILED);
  });

  it('a list whose only history is a failed send is replaceable, but the failed guest is kept for retry', async () => {
    await upload([HEAD, ['Fail Fred', 'fred@x.com', ''], ['Idle Ida', 'ida@x.com', '']], 'REPLACE', 'f.xlsx');
    await Invitee.updateOne({ email: 'fred@x.com' }, { invitationStatus: InvitationStatus.FAILED });
    const res = await upload([HEAD, ['Next Nat', 'nat@x.com', '']], 'REPLACE', 'g.xlsx');
    expect(res.body.data.archived).toBe(1);
    expect(await names()).toEqual(['Fail Fred', 'Next Nat']);
  });

  it('Append keeps every existing guest and adds only the new ones', async () => {
    await upload([HEAD, ['Ann One', 'ann@x.com', '']], 'REPLACE', 'a.xlsx');
    const res = await upload([HEAD, ['Ann One', 'ann@x.com', ''], ['Dan Four', 'dan@x.com', '']], 'APPEND', 'b.xlsx');
    expect(res.body.data).toMatchObject({ imported: 1, archived: 0, mode: 'APPEND' });
    expect(await names()).toEqual(['Ann One', 'Dan Four']);
    expect(await Invitee.countDocuments({ eventId: event._id })).toBe(2);
  });

  it('Append with a file that only has guests the event already has changes nothing', async () => {
    await upload([HEAD, ['Ann One', 'ann@x.com', '']], 'REPLACE');
    const res = await upload([HEAD, ['Ann One', 'ann@x.com', '']], 'APPEND');
    expect(res.body.data).toMatchObject({ imported: 0, archived: 0 });
    expect(res.body.data.setId).toBeNull();
  });

  it('rows matching a guest in a sent list are not imported again and are reported as already invited', async () => {
    await upload([HEAD, ['Sent Sam', 'sam@x.com', ''], ['Sent Sue', '', '9876500001']], 'REPLACE', 'sent.xlsx');
    await Invitee.updateMany({}, { invitationStatus: InvitationStatus.SENT });
    // Sam by email in another case with a new name, Sue by phone in another format; a stranger who only shares Sam's name is NOT matched
    const res = await upload([HEAD, ['Sam Renamed', 'SAM@x.com', ''], ['Sue Phone', '', '+91 98765 00001'], ['Sent Sam', 'other@x.com', '']], 'REPLACE', 'new.xlsx');
    expect(res.body.data).toMatchObject({ imported: 1, alreadyInvited: 2, archived: 0 });
    expect(await Invitee.countDocuments({ eventId: event._id })).toBe(3);
    expect((await Invitee.findOne({ email: 'sam@x.com' }))?.name).toBe('Sent Sam');
  });

  it('duplicates inside the uploaded file are imported once', async () => {
    const res = await upload([HEAD, ['Dup One', 'dup@x.com', ''], ['Dup Again', 'DUP@x.com', ''], ['Same Phone', '', '9876500009'], ['Same Phone B', '', '+91 9876500009']], 'REPLACE');
    expect(res.body.data).toMatchObject({ imported: 2, rejected: 2, duplicateCount: 2 });
  });

  it('keeps invitation, RSVP, credential and attendance history intact through a replace', async () => {
    await upload([HEAD, ['Sam Sent', 'sam@x.com', ''], ['Rita Rsvp', 'rita@x.com', ''], ['Cal Checked', 'cal@x.com', '']], 'REPLACE', 'all.xlsx');
    const [sam, rita, cal] = await Promise.all(['sam', 'rita', 'cal'].map((n) => Invitee.findOne({ email: `${n}@x.com` })));
    await Invitee.updateOne({ _id: sam!._id }, { invitationStatus: InvitationStatus.SENT, qrTokenHash: 'hash-sam', credentialVersion: 2 });
    await Invitation.create({ eventId: event._id, inviteeId: sam!._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.SENT, tokenHash: 'th' } as any);
    await CredentialEvent.create({ eventId: event._id, inviteeId: sam!._id, organizerId: org._id, type: 'ISSUED', version: 1, source: 'SEND', tokenHash: 'hash-sam' } as any);
    await Invitee.updateOne({ _id: rita!._id }, { invitationStatus: InvitationStatus.SENT, rsvpStatus: RsvpStatus.ACCEPTED });
    await CheckIn.create({ eventId: event._id, inviteeId: cal!._id, checkInMethod: 'QR', checkedInBy: org._id } as any);
    const before = await Invitee.find({ eventId: event._id }).lean();
    const inv = await Invitation.countDocuments({ inviteeId: sam!._id }), cred = await CredentialEvent.countDocuments({ inviteeId: sam!._id }), chk = await CheckIn.countDocuments({ inviteeId: cal!._id });

    expect([inv, cred, chk]).toEqual([1, 1, 1]); // the history rows really exist before the replace

    await upload([HEAD, ['Someone Else', 'else@x.com', '']], 'REPLACE', 'other.xlsx');

    const after = await Invitee.find({ eventId: event._id, email: { $in: ['sam@x.com', 'rita@x.com', 'cal@x.com'] } }).lean();
    expect(after).toHaveLength(3);
    for (const b of before) expect(after.find((a) => String(a._id) === String(b._id))).toMatchObject({ invitationStatus: b.invitationStatus, rsvpStatus: b.rsvpStatus, ...(b.qrTokenHash ? { qrTokenHash: b.qrTokenHash } : {}) });
    expect(await Invitation.countDocuments({ inviteeId: sam!._id })).toBe(inv);
    expect(await CredentialEvent.countDocuments({ inviteeId: sam!._id })).toBe(cred);
    expect(await CheckIn.countDocuments({ inviteeId: cal!._id })).toBe(chk);
    expect(await Invitee.countDocuments({ eventId: event._id }).setOptions({ includeArchived: true })).toBe(4);
  });

  it('archived guests do not appear in the list, the counts, or by id', async () => {
    await upload([HEAD, ['Old Olga', 'olga@x.com', '']], 'REPLACE', 'old.xlsx');
    const old = await Invitee.findOne({ email: 'olga@x.com' });
    await upload([HEAD, ['New Nina', 'nina@x.com', '']], 'REPLACE', 'new.xlsx');
    const list = await request(app).get(`/api/v1/events/${event._id}/invitees`).set(bearer(tok));
    expect(list.body.data.map((i: any) => i.name)).toEqual(['New Nina']);
    expect((await request(app).get(`/api/v1/invitees/${old!._id}`).set(bearer(tok))).status).toBe(404);
    // the same email can be added again, because the archived record no longer counts as a duplicate
    const again = await upload([HEAD, ['Old Olga', 'olga@x.com', '']], 'APPEND', 'again.xlsx');
    expect(again.body.data.imported).toBe(1);
  });

  it('lists the event\'s uploads with their sent counts and lock state', async () => {
    await upload([HEAD, ['Alice A', 'a@x.com', ''], ['Bobby B', 'b@x.com', '']], 'REPLACE', 'one.xlsx');
    await Invitee.updateOne({ email: 'a@x.com' }, { invitationStatus: InvitationStatus.SENT });
    await upload([HEAD, ['Carol C', 'c@x.com', '']], 'APPEND', 'two.xlsx');
    const res = await request(app).get(`/api/v1/events/${event._id}/invitees/sets`).set(bearer(tok));
    expect(res.status).toBe(200);
    expect(res.body.data.hasSent).toBe(true);
    const byName = Object.fromEntries(res.body.data.sets.map((s: any) => [s.name, s]));
    expect(byName['one.xlsx']).toMatchObject({ total: 2, sent: 1, locked: true });
    expect(byName['two.xlsx']).toMatchObject({ total: 1, sent: 0, locked: false });
  });

  it('reports when each list was uploaded and when its invitations went out', async () => {
    await upload([HEAD, ['Alice A', 'a@x.com', ''], ['Bobby B', 'b@x.com', '']], 'REPLACE', 'one.xlsx');
    await upload([HEAD, ['Carol C', 'c@x.com', '']], 'APPEND', 'two.xlsx');
    const alice = await Invitee.findOne({ email: 'a@x.com' });
    const bobby = await Invitee.findOne({ email: 'b@x.com' });
    const t1 = new Date('2030-01-01T10:00:00Z'); const t2 = new Date('2030-01-02T11:30:00Z');
    for (const [inv, at] of [[alice, t1], [bobby, t2]] as const) {
      await Invitation.create({ eventId: event._id, inviteeId: inv!._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.SENT, tokenHash: `th-${inv!.email}`, sentAt: at } as any);
    }
    const res = await request(app).get(`/api/v1/events/${event._id}/invitees/sets`).set(bearer(tok));
    const byName = Object.fromEntries(res.body.data.sets.map((x: any) => [x.name, x]));
    expect(new Date(byName['one.xlsx'].firstSentAt).getTime()).toBe(t1.getTime());
    expect(new Date(byName['one.xlsx'].lastSentAt).getTime()).toBe(t2.getTime());
    expect(byName['one.xlsx'].createdAt).toBeTruthy();
    expect(byName['two.xlsx']).toMatchObject({ firstSentAt: null, lastSentAt: null });
  });

  it('previews one list, or all of them, a page at a time and with a search', async () => {
    await upload([HEAD, ['Alice A', 'a@x.com', ''], ['Bobby B', 'b@x.com', '']], 'REPLACE', 'one.xlsx');
    await upload([HEAD, ['Carol C', 'c@x.com', '']], 'APPEND', 'two.xlsx');
    const sets = (await request(app).get(`/api/v1/events/${event._id}/invitees/sets`).set(bearer(tok))).body.data.sets;
    const one = sets.find((x: any) => x.name === 'one.xlsx');
    const get = (id: string, qs = '') => request(app).get(`/api/v1/events/${event._id}/invitees/sets/${id}/members${qs}`).set(bearer(tok));
    expect((await get(one.id)).body.data.members.map((m: any) => m.name)).toEqual(['Alice A', 'Bobby B']);
    const all = await get('all', '?limit=2');
    expect(all.body.data).toMatchObject({ total: 3 });
    expect(all.body.data.members).toHaveLength(2);
    expect((await get('all', '?limit=2&page=2')).body.data.members.map((m: any) => m.name)).toEqual(['Carol C']);
    expect((await get('all', '?q=carol')).body.data.members.map((m: any) => m.name)).toEqual(['Carol C']);
    expect((await get('all', '?q=.*')).body.data.total).toBe(0); // typed text is not a pattern
  });

  it('keeps the food choice the guest\'s own: neither an Excel column nor a hand-added guest can set it', async () => {
    await upload([['Name', 'Email', 'Dietary Preference'], ['Dina D', 'dina@x.com', 'Vegan']], 'REPLACE', 'diet.xlsx');
    expect((await Invitee.findOne({ email: 'dina@x.com' }))!.dietaryPreference).toBeUndefined();
    const made = await request(app).post(`/api/v1/events/${event._id}/invitees`).set(bearer(tok)).send({ name: 'Hand Han', email: 'han@x.com', dietaryPreference: 'Veg' });
    expect(made.status).toBe(201);
    expect((await Invitee.findOne({ email: 'han@x.com' }))!.dietaryPreference).toBeUndefined();
  });

  it('rejects an unknown mode and other organizers cannot read the lists', async () => {
    expect((await upload([HEAD, ['Alice A', 'a@x.com', '']], 'WIPE' as any)).status).toBe(400);
    const other = await User.create({ fullName: 'Other', email: 'other.sets@example.com', role: Role.ORGANIZER });
    const res = await request(app).get(`/api/v1/events/${event._id}/invitees/sets`).set(bearer(generateAccessToken(String(other._id), Role.ORGANIZER)));
    expect(res.status).toBeGreaterThanOrEqual(403);
  });
});

describe('Professional Identity in imports', () => {
  it('imports the column, saves the value, and keeps an existing one on re-upload', async () => {
    const H = ['Name', 'Email', 'Professional Identity'];
    const res = await upload([H, ['Pia', 'pia@x.com', 'Employee ID: 4521'], ['Quin', 'quin@x.com', '']], 'REPLACE');
    expect(res.body.data.imported).toBe(2);
    expect((await Invitee.findOne({ email: 'pia@x.com' }))?.professionalIdentity).toBe('Employee ID: 4521');
    expect((await Invitee.findOne({ email: 'quin@x.com' }))?.professionalIdentity).toBeUndefined();
    await upload([H, ['Pia', 'pia@x.com', 'Employee ID: 9999'], ['Quin', 'quin@x.com', 'Licence 77']], 'APPEND');
    expect((await Invitee.findOne({ email: 'pia@x.com' }))?.professionalIdentity).toBe('Employee ID: 4521');
    expect((await Invitee.findOne({ email: 'quin@x.com' }))?.professionalIdentity).toBe('Licence 77');
  });
});

describe('archived guests: historical integrity and no accidental reactivation', () => {
  const idOf = async (email: string) => (await Invitee.findOne({ email }).setOptions({ includeArchived: true }))!._id;

  it('the replace is recorded in the audit log, with the counts and the new list', async () => {
    await upload([HEAD, ['Old Olga', 'olga@x.com', '']], 'REPLACE', 'old.xlsx');
    const res = await upload([HEAD, ['New Nina', 'nina@x.com', '']], 'REPLACE', 'new.xlsx');
    const { AuditLog } = await import('../src/models/AuditLog');
    const q = { action: 'INVITEE_IMPORT', 'metadata.setId': res.body.data.setId };
    for (let i = 0; i < 30 && !(await AuditLog.countDocuments(q)); i++) await new Promise((r) => setTimeout(r, 100));
    const row: any = await AuditLog.findOne(q).lean();
    expect(row?.metadata).toMatchObject({ mode: 'REPLACE', archived: 1, imported: 1, setId: res.body.data.setId });
  });

  it('ordinary active-list operations cannot reach an archived guest', async () => {
    await upload([HEAD, ['Old Olga', 'olga@x.com', '']], 'REPLACE', 'old.xlsx');
    const id = String(await idOf('olga@x.com'));
    await upload([HEAD, ['New Nina', 'nina@x.com', '']], 'REPLACE', 'new.xlsx');
    expect((await Invitee.findById(id).setOptions({ includeArchived: true }))?.archivedAt).toBeTruthy();

    const patch = await request(app).patch(`/api/v1/invitees/${id}`).set(bearer(tok)).send({ name: 'Reactivated' });
    const del = await request(app).delete(`/api/v1/invitees/${id}`).set(bearer(tok));
    const send = await request(app).post(`/api/v1/events/${event._id}/invitations/send`).set(bearer(tok)).send({ inviteeIds: [id], channel: 'EMAIL' });
    const bulk = await request(app).put(`/api/v1/events/${event._id}/invitees/session-access/bulk`).set(bearer(tok)).send({ inviteeIds: [id], sessionAccess: [{ sessionId: String(new mongoose.Types.ObjectId()), allowed: true }] });
    const revoke = await request(app).post(`/api/v1/invitees/${id}/revoke`).set(bearer(tok)).send({ category: 'OTHER', note: 'x' });
    for (const r of [patch, del, send, bulk, revoke]) expect(r.status).toBeGreaterThanOrEqual(400);
    const still: any = await Invitee.findById(id).setOptions({ includeArchived: true }).lean();
    expect(still).toMatchObject({ name: 'Old Olga', invitationStatus: 'PENDING' });
    expect(still.archivedAt).toBeTruthy();
    expect(await Invitation.countDocuments({ inviteeId: id })).toBe(0);
  });

  it('re-uploading an archived person creates a fresh record; the archived one is not revived', async () => {
    await upload([HEAD, ['Old Olga', 'olga@x.com', '']], 'REPLACE', 'old.xlsx');
    const oldId = String(await idOf('olga@x.com'));
    await upload([HEAD, ['New Nina', 'nina@x.com', '']], 'REPLACE', 'new.xlsx');
    const res = await upload([HEAD, ['Old Olga', 'olga@x.com', '']], 'APPEND', 'back.xlsx');
    expect(res.body.data.imported).toBe(1);
    const all = await Invitee.find({ email: 'olga@x.com' }).setOptions({ includeArchived: true }).lean();
    expect(all).toHaveLength(2);
    expect(all.find((i) => String(i._id) === oldId)?.archivedAt).toBeTruthy();
    expect(all.find((i) => String(i._id) !== oldId)?.archivedAt).toBeFalsy();
  });

  it('reports count only active guests; sent guests, their invitations and check-ins remain in history after a replace', async () => {
    await upload([HEAD, ['Sent Sam', 'sam@x.com', '']], 'REPLACE', 'one.xlsx');
    const sam = await Invitee.findOne({ email: 'sam@x.com' });
    await Invitee.updateOne({ _id: sam!._id }, { invitationStatus: InvitationStatus.SENT });
    await Invitation.create({ eventId: event._id, inviteeId: sam!._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.SENT, tokenHash: 'th' } as any);
    await CheckIn.create({ eventId: event._id, inviteeId: sam!._id, checkInMethod: 'QR', checkedInBy: org._id } as any);
    await upload([HEAD, ['Idle Ida', 'ida@x.com', '']], 'APPEND', 'idle.xlsx');
    await upload([HEAD, ['Fresh Fay', 'fay@x.com', '']], 'REPLACE', 'two.xlsx');
    const report = await request(app).get(`/api/v1/reports/events/${event._id}`).set(bearer(tok));
    expect(report.status).toBe(200);
    const text = JSON.stringify(report.body);
    // Sam (sent, checked in) and Fay are active; Ida (never invited, replaced) is archived and not counted
    expect(await Invitee.countDocuments({ eventId: event._id })).toBe(2);
    expect(await Invitee.countDocuments({ eventId: event._id }).setOptions({ includeArchived: true })).toBe(3);
    expect(text).not.toMatch(/Idle Ida/);
    expect(await Invitation.countDocuments({ inviteeId: sam!._id })).toBe(1);
    expect(await CheckIn.countDocuments({ inviteeId: sam!._id })).toBe(1);
  });
});
