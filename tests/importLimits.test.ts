// One upload holds up to 5000 guests and is stored as lists of at most 500; more than that is arranged through the contact page; and
// only one upload runs at a time per person and event, with a short cooldown after a successful one.
import mongoose from 'mongoose';
import supertest from 'supertest';
import xlsx from 'xlsx';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { InviteeSet } from '../src/models/InviteeSet';
import { generateAccessToken } from '../src/utils/token';

const request = supertest(app);
jest.setTimeout(180_000);

describe('upload size, lists of 500, one at a time', () => {
  let mongo: MongoMemoryServer; let org: any, event: any, auth: { Authorization: string };
  const H = ['Name', 'Email', 'Mobile'];
  const rows = (n: number, tag = 'g') => [H, ...Array.from({ length: n }, (_, i) => [`Guest ${tag}${i}`, `${tag}${i}@lim.test`, ''])];
  const sheet = (r: (string | number)[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(r), 'I'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };
  const upload = (r: (string | number)[][], extra: Record<string, string> = {}) => {
    let q = request.post(`/api/v1/events/${event._id}/invitees/import`).set(auth).field('mode', 'APPEND');
    for (const [k, v] of Object.entries(extra)) q = q.field(k, v);
    return q.attach('file', sheet(r), 'big list.xlsx');
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    org = await User.create({ fullName: 'Org', email: 'org@lim.test', role: Role.ORGANIZER, passwordHash: 'x', isActive: true });
    auth = { Authorization: `Bearer ${generateAccessToken(String(org._id), org.role)}` };
    event = await Event.create({ organizerId: org._id, title: 'E', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: 'x', coordinates: [0, 0] } as any, schedule: { start: new Date(Date.now() + 3600e3), end: new Date(Date.now() + 7200e3) }, status: 'PUBLISHED' });
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('a small file is one list; a large one is split into lists of at most 500', async () => {
    const small = await upload(rows(120, 's'));
    expect(small.status).toBe(200);
    expect(small.body.data.setIds).toHaveLength(1);
    const big = await upload(rows(1200, 'b'));
    expect(big.status).toBe(200);
    expect(big.body.data.imported).toBe(1200);
    expect(big.body.data.setIds).toHaveLength(3);
    const sets: any[] = await InviteeSet.find({ _id: { $in: big.body.data.setIds } }).sort({ createdAt: 1 }).lean();
    expect(sets.map((s) => s.name)).toEqual(['big list.xlsx (1 of 3)', 'big list.xlsx (2 of 3)', 'big list.xlsx (3 of 3)']);
    expect(sets.map((s) => s.importedCount)).toEqual([500, 500, 200]);
    for (const s of sets) expect(await Invitee.countDocuments({ eventId: event._id, inviteeSetId: s._id })).toBe(s.importedCount);
    expect(big.body.data.setId).toBe(big.body.data.setIds[0]);
  });

  it('exactly 5000 guests is accepted (ten lists); one more is refused with a pointer to the contact page, and nothing is written', async () => {
    const ev2 = await Event.create({ organizerId: org._id, title: 'E2', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: 'x', coordinates: [0, 0] } as any, schedule: { start: new Date(Date.now() + 3600e3), end: new Date(Date.now() + 7200e3) }, status: 'PUBLISHED' });
    const post = (r: (string | number)[][]) => request.post(`/api/v1/events/${ev2._id}/invitees/import`).set(auth).field('mode', 'APPEND').attach('file', sheet(r), 'x.xlsx');
    const tooMany = await post(rows(5001, 't'));
    expect(tooMany.status).toBe(413);
    expect(tooMany.body).toMatchObject({ code: 'IMPORT_TOO_LARGE', limit: 5000 });
    expect(tooMany.body.message).toContain('contact us');
    expect(await Invitee.countDocuments({ eventId: ev2._id })).toBe(0);
    const ok = await post(rows(5000, 'o'));
    expect(ok.status).toBe(200);
    expect(ok.body.data.setIds).toHaveLength(10);
    expect(await Invitee.countDocuments({ eventId: ev2._id })).toBe(5000);
  });
});

describe('one upload at a time, and a cooldown', () => {
  beforeAll(() => { process.env.ENABLE_RATE_LIMIT_TESTS = 'true'; });
  afterAll(() => { delete process.env.ENABLE_RATE_LIMIT_TESTS; });

  it('refuses a second upload while the first runs, a repeat inside the cooldown, and lets a preview through', async () => {
    const mongo2 = await MongoMemoryServer.create();
    await mongoose.disconnect();
    await mongoose.connect(mongo2.getUri());
    const org = await User.create({ fullName: 'Org', email: 'org2@lim.test', role: Role.ORGANIZER, passwordHash: 'x', isActive: true });
    const auth = { Authorization: `Bearer ${generateAccessToken(String(org._id), org.role)}` };
    const event = await Event.create({ organizerId: org._id, title: 'E', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: 'x', coordinates: [0, 0] } as any, schedule: { start: new Date(Date.now() + 3600e3), end: new Date(Date.now() + 7200e3) }, status: 'PUBLISHED' });
    const H = ['Name', 'Email', 'Mobile'];
    const file = (tag: string, n: number) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([H, ...Array.from({ length: n }, (_, i) => [`G ${tag}${i}`, `${tag}${i}@g.test`, ''])]), 'I'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };
    const send = (tag: string, n: number, extra: Record<string, string> = {}) => {
      let q = request.post(`/api/v1/events/${event._id}/invitees/import`).set(auth).field('mode', 'APPEND');
      for (const [k, v] of Object.entries(extra)) q = q.field(k, v);
      return q.attach('file', file(tag, n), 'l.xlsx');
    };
    // two at once: one wins, the other is told an upload is already running
    const [a, b] = await Promise.all([send('a', 600), send('b', 600)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.code).toBe('UPLOAD_IN_PROGRESS');
    // straight after a success: the cooldown
    const again = await send('c', 5);
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('UPLOAD_COOLDOWN');
    expect(again.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    // a preview is never held up by it
    const preview = await send('d', 5, { dryRun: 'true' });
    expect(preview.status).toBe(200);
    await mongoose.disconnect();
    await mongo2.stop();
  });
});
