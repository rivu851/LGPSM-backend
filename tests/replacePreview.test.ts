import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as xlsx from 'xlsx';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventStatus } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation, DeliveryChannel, InvitationDeliveryStatus } from '../src/models/Invitation';
import { InviteeSet } from '../src/models/InviteeSet';
import { AuditLog } from '../src/models/AuditLog';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60_000);
let mongo: MongoMemoryServer;
let orgA: any, orgB: any, staff: any, tA: string, tB: string, tStaff: string, event: any;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const HEAD = ['Name', 'Email', 'Mobile'];
const sheet = (rows: (string | number)[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'I'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };
const send = (rows: (string | number)[][], mode: 'REPLACE' | 'APPEND', dryRun: boolean, file = 'new.xlsx', who = tA) => {
  const r = request(app).post(`/api/v1/events/${event._id}/invitees/import`).set(bearer(who)).field('mode', mode);
  if (dryRun) r.field('dryRun', 'true');
  return r.attach('file', sheet(rows), file);
};
const snapshot = async () => JSON.stringify({
  invitees: await Invitee.collection.find({}).sort({ _id: 1 }).toArray(),
  sets: await InviteeSet.collection.find({}).sort({ _id: 1 }).toArray(),
  audit: await AuditLog.countDocuments({}),
  invitations: await Invitation.countDocuments({})
});

/** locked list (sent + not sent), failed-only list (failed + never-attempted), unknown list (unsettled + never-attempted), draft list (all never-attempted) */
async function seed() {
  await send([HEAD, ['Sent Sam', 'sam@x.com', ''], ['Pending Pat', 'pat@x.com', '']], 'REPLACE', false, 'sent.xlsx');
  await send([HEAD, ['Failed Fiona', 'fiona@x.com', ''], ['Idle Ivan', 'ivan@x.com', '']], 'APPEND', false, 'failed.xlsx');
  await send([HEAD, ['Unknown Uma', 'uma@x.com', ''], ['Idle Ute', 'ute@x.com', '']], 'APPEND', false, 'unknown.xlsx');
  await send([HEAD, ['Draft Dee', 'dee@x.com', ''], ['Draft Dan', 'dan@x.com', '']], 'APPEND', false, 'draft.xlsx');
  await Invitee.updateOne({ email: 'sam@x.com' }, { invitationStatus: InvitationStatus.SENT });
  await Invitee.updateOne({ email: 'fiona@x.com' }, { invitationStatus: InvitationStatus.FAILED });
  const uma: any = await Invitee.findOne({ email: 'uma@x.com' });
  await Invitation.create({ eventId: event._id, inviteeId: uma._id, channel: DeliveryChannel.EMAIL, status: InvitationDeliveryStatus.PENDING, tokenHash: 'th' } as any);
}
const FILE = [HEAD, ['New Nia', 'nia@x.com', ''], ['New Ned', 'ned@x.com', '9876500021'], ['Pending Pat', 'pat@x.com', ''], ['Dup Dora', 'nia@x.com', ''], ['No Contact', '', ''], ['X', 'bad', '']];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const mk = (n: string, e: string, role: Role) => User.create({ fullName: n, email: e, role, isActive: true });
  orgA = await mk('Org A', 'a.rp@x.com', Role.ORGANIZER); orgB = await mk('Org B', 'b.rp@x.com', Role.ORGANIZER); staff = await mk('Staff', 's.rp@x.com', Role.SYSTEM_USER);
  tA = generateAccessToken(String(orgA._id), Role.ORGANIZER); tB = generateAccessToken(String(orgB._id), Role.ORGANIZER); tStaff = generateAccessToken(String(staff._id), Role.SYSTEM_USER);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([Invitee, Event, InviteeSet, Invitation, AuditLog, SystemUserAssignment].map((m: any) => m.deleteMany({})));
  event = await Event.create({ organizerId: orgA._id, title: 'P', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', status: EventStatus.PUBLISHED, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 864e5 + 36e5) } } as any);
  await SystemUserAssignment.create({ userId: staff._id, eventId: event._id, sessionIds: [], assignedBy: orgA._id });
});

describe('Replace preview', () => {
  it('reports what a Replace would do, accurately', async () => {
    await seed();
    const res = await send(FILE, 'REPLACE', true);
    expect(res.status).toBe(200);
    const p = res.body.data.preview;
    expect(res.body.data.dryRun).toBe(true);
    expect(p).toMatchObject({
      totalRows: 6,           // rows in the file (header excluded)
      validNew: 2,            // Nia and Ned
      existingActive: 8,
      lockedGuestsKept: 2,    // Sam and Pat: the whole sent list is kept
      failedKept: 1,          // Fiona
      unknownKept: 1,         // Uma
      wouldSetAside: 4,       // Ivan, Ute, Dee, Dan: never attempted, in open lists, not in the file
      preservedSets: 1,
      matchedExistingGuests: 1 // Pending Pat is already on the list
    });
    expect(p.duplicateRows).toBe(1);      // "Dup Dora" repeats Nia's email inside the file
    expect(p.rejectedRows).toBe(3);       // duplicate within the file, no contact, invalid name/email
    expect(p.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|cipher|secret/i);
  });

  it('changes nothing: no guest, list, delivery record or audit entry is written', async () => {
    await seed();
    const before = await snapshot();
    const replace = await send(FILE, 'REPLACE', true);
    const append = await send(FILE, 'APPEND', true);
    expect(replace.status).toBe(200); expect(append.status).toBe(200);
    expect(await snapshot()).toBe(before);
  });

  it('an Append preview never sets anything aside', async () => {
    await seed();
    const p = (await send(FILE, 'APPEND', true)).body.data.preview;
    expect(p.wouldSetAside).toBe(0);
    expect(p.validNew).toBe(2);
  });

  it('matches what the real Replace then does', async () => {
    await seed();
    const p = (await send(FILE, 'REPLACE', true)).body.data.preview;
    const real = (await send(FILE, 'REPLACE', false)).body.data;
    expect(real.imported).toBe(p.validNew);
    expect(real.archived).toBe(p.wouldSetAside);
    expect(real.failedKept).toBe(p.failedKept);
    expect(real.unknownKept).toBe(p.unknownKept);
    expect(real.preservedSets).toBe(p.preservedSets);
    expect(real.rejected).toBe(p.rejectedRows);
    expect(real.duplicateCount).toBe(p.duplicateRows);
  });

  it('is re-checked by the real Replace: a guest invited after the preview is no longer set aside, and a duplicate that appeared is skipped', async () => {
    await seed();
    const p = (await send(FILE, 'REPLACE', true)).body.data.preview;
    expect(p.wouldSetAside).toBe(4);
    // between preview and confirmation: Ivan is invited (successfully), and someone adds Nia by hand
    await Invitee.updateOne({ email: 'ivan@x.com' }, { invitationStatus: InvitationStatus.SENT });
    await Invitee.create({ eventId: event._id, name: 'Nia By Hand', email: 'nia@x.com', invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [] });
    const real = (await send(FILE, 'REPLACE', false)).body.data;
    // Ivan's list is now Locked (a successful send), so none of the failed-list guests are set aside any more
    expect(real.archived).toBe(3);        // Ute, Dee, Dan
    expect(real.archived).toBeLessThan(p.wouldSetAside);
    expect(real.preservedSets).toBe(2);   // the sent list and the list Ivan is in
    expect(real.imported).toBe(1);        // only Ned: Nia is now taken
    expect(real.imported).toBeLessThan(p.validNew);
    expect((await Invitee.findOne({ email: 'ivan@x.com' }))!.archivedAt).toBeNull();
    expect(await Invitee.countDocuments({ eventId: event._id, email: 'nia@x.com' })).toBe(1);
  });

  it('is available to the event owner and admins only', async () => {
    await seed();
    expect([403, 404]).toContain((await send(FILE, 'REPLACE', true, 'new.xlsx', tB)).status);
    expect((await send(FILE, 'REPLACE', true, 'new.xlsx', tStaff)).status).toBe(403);
  });
});
