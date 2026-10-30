import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as xlsx from 'xlsx';
import { User, Role } from '../src/models/User';
import { Event, EventStatus } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { InviteeSet } from '../src/models/InviteeSet';

// "Instance" = a separate copy of the application's modules (its own mongoose, models, connection pool and its own
// in-process lock) talking to the SAME MongoDB, like two backend processes. Nothing in-process can coordinate them: if
// the outcomes below are always consistent, the database is what enforces it.
jest.setTimeout(120_000);

let mongo: MongoMemoryServer;
let org: any;
interface Instance { m: typeof mongoose; Invitee: typeof Invitee; inviteeService: any; inviteeSetService: any; inviteeRepository: any }
let A: Instance, B: Instance;

function loadInstance(): Instance {
  let inst: any;
  jest.isolateModules(() => {
    const m = require('mongoose');
    const models = require('../src/models/Invitee');
    require('../src/models/InviteeSet'); require('../src/models/Invitation'); require('../src/models/CheckIn'); require('../src/models/CredentialEvent');
    require('../src/models/Event'); require('../src/models/User'); require('../src/models/Session'); require('../src/models/AuditLog');
    inst = { m, Invitee: models.Invitee, inviteeService: require('../src/services/invitee.service').inviteeService, inviteeSetService: require('../src/services/inviteeSet.service').inviteeSetService, inviteeRepository: require('../src/repositories/invitee.repository').inviteeRepository };
  });
  return inst;
}
const sheet = (rows: (string | number)[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'I'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };
const mkEvent = () => Event.create({ organizerId: org._id, title: 'D', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', status: EventStatus.PUBLISHED, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 864e5 + 36e5) } } as any);
const archivedGuest = (ev: any, extra: Record<string, unknown>) => Invitee.create({ eventId: ev._id, name: 'Draft Dee', invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, sessionAccess: [], archivedAt: new Date(), archivedReason: 'SUPERSEDED_BY_UPLOAD', ...extra } as any) as any;
const actor = () => ({ userId: String(org._id), role: 'ORGANIZER' });
const runImport = (inst: Instance, ev: any, rows: (string | number)[][]) =>
  inst.inviteeService.processExcelImport(String(ev._id), String(org._id), sheet(rows), { role: 'ORGANIZER', mode: 'APPEND', fileName: 'race.xlsx' }).then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, code: e?.code, message: e?.message }));
const active = (ev: any, filter: Record<string, unknown>) => Invitee.countDocuments({ eventId: ev._id, ...filter });
const ROUNDS = 12;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  await mongoose.connect(uri);
  org = await User.create({ fullName: 'Org', email: 'org.dist@x.com', role: Role.ORGANIZER, isActive: true });
  A = loadInstance(); B = loadInstance();
  await Promise.all([A.m.connect(uri), B.m.connect(uri)]);
  await Promise.all([A.Invitee.init(), B.Invitee.init(), Invitee.init()]);
});
afterAll(async () => { await Promise.all([A.m.disconnect(), B.m.disconnect(), mongoose.disconnect()]); await mongo.stop(); });

describe('forced interleavings: each instance is paused between its own check and its own write', () => {
  afterEach(() => jest.restoreAllMocks());

  it('restore (instance A) passes its check, then instance B imports the same person: the database refuses A, the archived record is untouched', async () => {
    const ev = await mkEvent();
    const g = await archivedGuest(ev, { email: 'forced@x.com' });
    let importOutcome: any;
    const real = A.Invitee.updateOne.bind(A.Invitee);
    jest.spyOn(A.Invitee, 'updateOne').mockImplementationOnce(((...args: any[]) =>
      runImport(B, ev, [['Name', 'Email'], ['Imported Ivy', 'forced@x.com']]).then((o: any) => { importOutcome = o; return (real as any)(...args); })) as any);
    const res = await A.inviteeSetService.restore(actor(), String(ev._id), [String(g._id)]);
    expect(importOutcome.ok && importOutcome.r.imported).toBe(1);
    expect(res.results[0]).toMatchObject({ status: 'DUPLICATE_ACTIVE', conflictsWith: { name: 'Imported Ivy', matchedOn: 'email' } });
    const stored: any = await Invitee.findById(g._id).setOptions({ includeArchived: true } as any).lean();
    expect(stored.archivedAt).toBeTruthy();
    expect(stored.setAsideHistory).toBeUndefined();
    expect(await active(ev, { email: 'forced@x.com' })).toBe(1);
  });

  it('import (instance B) passes its duplicate check, then instance A restores the same person: the database stops B, which rolls back whole', async () => {
    const ev = await mkEvent();
    const g = await archivedGuest(ev, { email: 'forced2@x.com' });
    const realInsert = B.inviteeRepository.insertMany.bind(B.inviteeRepository);
    let restoreOutcome: any;
    jest.spyOn(B.inviteeRepository, 'insertMany').mockImplementationOnce((async (rows: any) => {
      restoreOutcome = await A.inviteeSetService.restore(actor(), String(ev._id), [String(g._id)]);
      return realInsert(rows);
    }) as any);
    const imp: any = await runImport(B, ev, [['Name', 'Email'], ['Other Olive', 'olive@x.com'], ['Imported Ivy', 'forced2@x.com']]);
    expect(restoreOutcome.restored).toBe(1);
    expect(imp.ok).toBe(false);
    expect(imp.code).toBe(11000);
    expect(await active(ev, { email: 'forced2@x.com' })).toBe(1);
    expect(((await Invitee.findById(g._id).lean()) as any).setAsideHistory).toHaveLength(1); // the restored guest is the original record
    expect(await Invitee.countDocuments({ eventId: ev._id, name: { $in: ['Other Olive', 'Imported Ivy'] } })).toBe(0); // nothing of the failed import survives
    expect(await InviteeSet.countDocuments({ eventId: ev._id })).toBe(0);
  });

  it('the same two interleavings for a phone number', async () => {
    const ev = await mkEvent();
    const g = await archivedGuest(ev, { mobile: '9876544444' });
    const real = A.Invitee.updateOne.bind(A.Invitee);
    jest.spyOn(A.Invitee, 'updateOne').mockImplementationOnce(((...args: any[]) =>
      runImport(B, ev, [['Name', 'Mobile'], ['Imported Ivy', '+91 98765 44444']]).then(() => (real as any)(...args))) as any);
    const res = await A.inviteeSetService.restore(actor(), String(ev._id), [String(g._id)]);
    expect(res.results[0]).toMatchObject({ status: 'DUPLICATE_ACTIVE', conflictsWith: { matchedOn: 'mobile' } });
    expect(await active(ev, { mobileKey: '919876544444' })).toBe(1);
  });
});

describe('two backend instances on one database', () => {
  it('really are independent (separate mongoose, models and in-process lock)', () => {
    expect(A.m).not.toBe(B.m);
    expect(A.m).not.toBe(mongoose);
    expect(A.inviteeSetService).not.toBe(B.inviteeSetService);
    expect(A.Invitee).not.toBe(B.Invitee);
  });

  it(`restore on one instance vs import on the other, same email: exactly one active guest, identity and history intact (${ROUNDS} rounds)`, async () => {
    const tally = { restoreWon: 0, importWon: 0 };
    for (let i = 0; i < ROUNDS; i++) {
      const ev = await mkEvent();
      const g = await archivedGuest(ev, { email: `dee${i}@x.com` });
      const [rest, imp] = await Promise.all([A.inviteeSetService.restore(actor(), String(ev._id), [String(g._id)]), runImport(B, ev, [['Name', 'Email'], ['Imported Ivy', `dee${i}@x.com`]])]);
      expect(await active(ev, { email: `dee${i}@x.com` })).toBe(1);
      const stored: any = await Invitee.findById(g._id).setOptions({ includeArchived: true } as any).lean();
      expect(stored.name).toBe('Draft Dee'); // the original record, never rewritten by the import
      const restored = rest.results[0].status === 'RESTORED';
      if (restored) {
        tally.restoreWon++;
        expect(stored.archivedAt).toBeNull();
        expect(stored.setAsideHistory).toHaveLength(1);
        expect(stored.invitationStatus).toBe('PENDING');
        // the import lost: it either found the restored guest (nothing imported) or was stopped by the database and rolled back
        expect(imp.ok ? imp.r.imported : 0).toBe(0);
        expect(await Invitee.countDocuments({ eventId: ev._id, name: 'Imported Ivy' })).toBe(0);
        if (!imp.ok) expect(imp.code).toBe(11000);
      } else {
        tally.importWon++;
        expect(rest.results[0].status).toBe('DUPLICATE_ACTIVE');
        expect(stored.archivedAt).toBeTruthy(); // archived record untouched
        expect(stored.setAsideHistory).toBeUndefined();
        expect(imp.ok && imp.r.imported).toBe(1);
        expect(await Invitee.countDocuments({ eventId: ev._id, name: 'Imported Ivy' })).toBe(1);
      }
      expect(await Invitee.countDocuments({ eventId: ev._id }).setOptions({ includeArchived: true } as any)).toBe(2 - (restored ? 1 : 0));
    }
    console.log('email race outcomes', tally);
  });

  it(`the same race on the phone number, written differently on each side (${ROUNDS} rounds)`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const ev = await mkEvent();
      const phone = `98765${String(10000 + i)}`;
      const g = await archivedGuest(ev, { mobile: phone });
      const [rest, imp] = await Promise.all([B.inviteeSetService.restore(actor(), String(ev._id), [String(g._id)]), runImport(A, ev, [['Name', 'Mobile'], ['Imported Ivy', `+91 ${phone.slice(0, 5)}-${phone.slice(5)}`]])]);
      expect(await active(ev, { mobileKey: `91${phone}` })).toBe(1);
      const stored: any = await Invitee.findById(g._id).setOptions({ includeArchived: true } as any).lean();
      expect(String(stored._id)).toBe(String(g._id));
      expect(stored.name).toBe('Draft Dee');
      const restored = rest.results[0].status === 'RESTORED';
      expect(restored || rest.results[0].status === 'DUPLICATE_ACTIVE').toBe(true);
      expect(restored ? stored.archivedAt === null : !!stored.archivedAt).toBe(true);
      if (!restored) expect(imp.ok && imp.r.imported).toBe(1);
    }
  });

  it(`two set-aside guests who share a contact, restored from different instances at once: one wins, the other stays set aside (${ROUNDS} rounds)`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const ev = await mkEvent();
      const g1 = await archivedGuest(ev, { name: 'Twin One', email: `twin${i}@x.com`, mobile: `98770${String(10000 + i)}` });
      const g2 = await archivedGuest(ev, { name: 'Twin Two', email: `twin${i}@x.com`, mobile: `98771${String(10000 + i)}` });
      const [r1, r2] = await Promise.all([A.inviteeSetService.restore(actor(), String(ev._id), [String(g1._id)]), B.inviteeSetService.restore(actor(), String(ev._id), [String(g2._id)])]);
      expect(r1.restored + r2.restored).toBe(1);
      expect([r1.refused, r2.refused].sort()).toEqual([0, 1]);
      expect(await active(ev, { email: `twin${i}@x.com` })).toBe(1);
      const all = await Invitee.find({ eventId: ev._id }).setOptions({ includeArchived: true } as any).lean();
      expect(all).toHaveLength(2); // nobody deleted, nobody duplicated
      expect(all.filter((x: any) => x.archivedAt).length).toBe(1);
    }
  });

  it('the same restore sent to both instances changes the guest once', async () => {
    for (let i = 0; i < 6; i++) {
      const ev = await mkEvent();
      const g = await archivedGuest(ev, { email: `once${i}@x.com` });
      const [r1, r2] = await Promise.all([A.inviteeSetService.restore(actor(), String(ev._id), [String(g._id)]), B.inviteeSetService.restore(actor(), String(ev._id), [String(g._id)])]);
      expect(r1.restored + r2.restored).toBe(1);
      expect(r1.alreadyActive + r2.alreadyActive).toBe(1);
      expect(((await Invitee.findById(g._id).lean()) as any).setAsideHistory).toHaveLength(1);
    }
  });

  it('two imports of the same person from different instances create one guest', async () => {
    for (let i = 0; i < 8; i++) {
      const ev = await mkEvent();
      const rows = [['Name', 'Email', 'Mobile'], ['Same Sam', `sam${i}@x.com`, `98772${String(10000 + i)}`]];
      const [x, y] = await Promise.all([runImport(A, ev, rows), runImport(B, ev, rows)]);
      expect(await active(ev, { email: `sam${i}@x.com` })).toBe(1);
      expect(await active(ev, { mobileKey: `91${98772}${String(10000 + i)}` })).toBe(1);
      expect([x, y].filter((r: any) => r.ok && r.r.imported === 1).length).toBe(1);
      for (const r of [x, y] as any[]) if (!r.ok) expect(r.code).toBe(11000);
      expect(await InviteeSet.countDocuments({ eventId: ev._id })).toBe(1); // a rolled-back import leaves no list behind
    }
  });
});
