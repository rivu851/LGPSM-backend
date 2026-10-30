import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation } from '../src/models/Invitation';
import { CheckIn } from '../src/models/CheckIn';
import { AuditLog } from '../src/models/AuditLog';
import { CancellationNotice } from '../src/models/CancellationNotice';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { Session } from '../src/models/Session';
import { clock } from '../src/utils/clock';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

// Admission writes run in a MongoDB transaction that also updates the event document, so they are strictly ordered
// against a cancel/close (which update the same document). A replica set is needed for transactions; this is what Atlas is.
const START = new Date('2026-10-31T04:30:00.000Z');
const END = new Date('2026-10-31T11:30:00.000Z');
const DURING = new Date('2026-10-31T06:00:00.000Z');
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const GUESTS = 14;

describe('check-in vs cancel/close: one well-defined order (transactions)', () => {
  let repl: MongoMemoryServer;
  let org: any, tOrg: string;
  let event: any;
  let raws: string[];

  beforeAll(async () => {
    // A one-node replica set started by hand: mongod is run with --replSet and initiated through our own driver connection
    // (MongoMemoryReplSet's helper client is rejected by this mongod's handshake check).
    repl = await MongoMemoryServer.create({ instance: { replSet: 'rs0' } });
    const direct = `mongodb://127.0.0.1:${repl.instanceInfo!.port}/?directConnection=true`;
    const boot = await mongoose.createConnection(direct).asPromise();
    await boot.db!.admin().command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${repl.instanceInfo!.port}` }] } });
    for (let i = 0; i < 100; i++) {
      const hello: any = await boot.db!.admin().command({ hello: 1 });
      if (hello.isWritablePrimary) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await boot.close();
    await mongoose.connect(direct);
    await Promise.all([CheckIn, Event, Invitee, AuditLog, CancellationNotice].map((m: any) => m.createCollection().catch(() => undefined)));
    await Promise.all([CheckIn, Event].map((m: any) => m.syncIndexes()));
  }, 120_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await repl.stop();
  }, 60_000);

  beforeEach(async () => {
    await Promise.all([User, Event, Invitee, Invitation, CheckIn, AuditLog, CancellationNotice, SystemUserAssignment, Session].map((m: any) => m.deleteMany({})));
    org = await User.create({ fullName: 'Org', email: 'org@x.com', role: Role.ORGANIZER, isActive: true });
    tOrg = generateAccessToken(String(org._id), org.role);
    event = await Event.create({
      organizerId: org._id, title: 'Race', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL,
      schedule: { start: START, end: END }, status: EventStatus.PUBLISHED,
      rsvp: { enabled: false, allowAllInvited: true, allowNotResponded: true, allowDeclined: true }
    });
    raws = [];
    for (let i = 0; i < GUESTS; i++) {
      const raw = generateSecureToken();
      raws.push(raw);
      await Invitee.create({ eventId: event._id, name: `G${i}`, email: `g${i}@x.com`, invitationStatus: InvitationStatus.SENT, rsvpStatus: RsvpStatus.ACCEPTED, qrTokenHash: hashToken(raw), sessionAccess: [] });
    }
    jest.spyOn(clock, 'now').mockReturnValue(DURING);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  }, 60_000);
  afterEach(() => jest.restoreAllMocks());

  const scan = (raw: string) => request(app).post('/api/v1/checkins/scan').set(auth(tOrg)).send({ qrCode: raw, eventId: String(event._id) });

  /**
   * The proof of ordering: the event's counter is bumped by every admission in the same transaction as its record, and the
   * cancel/close copies it into `finalAdmissionSeq` in the atomic update that ends the event. If any attendance record were
   * written after the event ended, the records would outnumber `finalAdmissionSeq`.
   */
  const expectCleanOrdering = async (results: request.Response[], endedAs: EventStatus) => {
    const ev: any = await Event.findById(event._id);
    expect(ev.status).toBe(endedAs);
    const records = await CheckIn.countDocuments({ eventId: event._id });
    expect(records).toBe(ev.finalAdmissionSeq);
    expect(records).toBe(ev.admissionSeq);
    // what staff were told matches what is stored: every 201 has its record, every refusal left nothing
    expect(results.filter((r) => r.status === 201)).toHaveLength(records);
    for (const r of results.filter((x) => x.status !== 201)) expect(['EVENT_CANCELLED', 'EVENT_COMPLETED']).toContain(r.body.code);
    return records;
  };

  it('scans racing a cancellation: no attendance is written after it, and none is lost before it', async () => {
    const seen = new Set<number>();
    for (let round = 0; round < 4; round++) {
      await Promise.all([Event, CheckIn, CancellationNotice].map((m: any) => m.deleteMany(m === Event ? { _id: { $ne: event._id } } : {})));
      await Event.updateOne({ _id: event._id }, { status: EventStatus.PUBLISHED, admissionSeq: 0, $unset: { finalAdmissionSeq: 1, cancelledAt: 1 } });
      // the cancellation is fired a little way into the scan burst, at a different point each round
      const calls: Promise<request.Response>[] = raws.map((r, i) => (i === 3 + round * 2 ? (request(app).post(`/api/v1/events/${event._id}/cancel`).set(auth(tOrg)).send({}) as any) : scan(r)));
      const results = await Promise.all(calls);
      const scans = results.filter((_, i) => i !== 3 + round * 2);
      expect(results[3 + round * 2].status).toBe(200);
      seen.add(await expectCleanOrdering(scans, EventStatus.CANCELLED));
    }
    expect(seen.size).toBeGreaterThan(0);
  }, 120_000);

  it('scans racing an event close behave the same way', async () => {
    for (let round = 0; round < 3; round++) {
      await CheckIn.deleteMany({});
      await Event.updateOne({ _id: event._id }, { status: EventStatus.PUBLISHED, admissionSeq: 0, $unset: { finalAdmissionSeq: 1, closedAt: 1 } });
      const closeAt = 2 + round * 3;
      const results = await Promise.all(raws.map((r, i) => (i === closeAt ? (request(app).post(`/api/v1/events/${event._id}/close`).set(auth(tOrg)) as any) : scan(r))));
      expect(results[closeAt].status).toBe(200);
      await expectCleanOrdering(results.filter((_, i) => i !== closeAt), EventStatus.COMPLETED);
    }
  }, 120_000);

  it('the same guest scanned in parallel while the event is cancelled still yields at most one record', async () => {
    const results = await Promise.all([...Array.from({ length: 6 }, () => scan(raws[0])), request(app).post(`/api/v1/events/${event._id}/cancel`).set(auth(tOrg)).send({}) as any, ...Array.from({ length: 6 }, () => scan(raws[0]))]);
    expect(await CheckIn.countDocuments({ inviteeId: (await Invitee.findOne({ name: 'G0' }))?._id })).toBeLessThanOrEqual(1);
    const ev: any = await Event.findById(event._id);
    expect(await CheckIn.countDocuments()).toBe(ev.finalAdmissionSeq);
    expect(results.filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('after the cancellation has committed, every scan is refused and nothing more is stored', async () => {
    await Promise.all(raws.slice(0, 4).map(scan));
    expect((await request(app).post(`/api/v1/events/${event._id}/cancel`).set(auth(tOrg)).send({})).status).toBe(200);
    const stored = await CheckIn.countDocuments();
    const late = await Promise.all(raws.slice(4).map(scan));
    for (const r of late) { expect(r.status).toBe(409); expect(r.body.code).toBe('EVENT_CANCELLED'); }
    expect(await CheckIn.countDocuments()).toBe(stored);
    const ev: any = await Event.findById(event._id);
    expect(stored).toBe(ev.finalAdmissionSeq);
    expect(stored).toBe(4);
  }, 60_000);

  it('uses a transaction on this deployment (a replica set), not the fallback', async () => {
    const start = jest.spyOn(mongoose, 'startSession');
    expect((await scan(raws[0])).status).toBe(201);
    expect(start).toHaveBeenCalled();
  });

  it('a rejected scan leaves no trace: no record and no counter movement', async () => {
    await request(app).post(`/api/v1/events/${event._id}/cancel`).set(auth(tOrg)).send({});
    const before: any = await Event.findById(event._id);
    await scan(raws[0]);
    const after: any = await Event.findById(event._id);
    expect(after.admissionSeq).toBe(before.admissionSeq);
    expect(await CheckIn.countDocuments()).toBe(0);
  });
});
