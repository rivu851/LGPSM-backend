// Printable cards: one zip per part, one PDF per guest, in a stable order; only for events set to print.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(120000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
let mongo: MongoMemoryServer; let org: any; let other: any; let cat: any;
const day = 864e5;
const binary = (res: any, cb: any) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
const mkEvent = (invitationType: string) => Event.create({ organizerId: org._id, title: 'Gala Night', description: 'd', categoryId: cat._id, format: 'PHYSICAL', status: 'PUBLISHED', invitationType, contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
const mkGuests = (ev: any, n: number) => Invitee.insertMany(Array.from({ length: n }, (_, i) => ({ eventId: ev._id, name: `Guest ${i + 1}`, email: `g${i + 1}@x.com`, mobile: `98${String(10000000 + i)}` })));
// names of the entries in a zip, read from its central directory
const entries = (zip: Buffer) => {
  const names: string[] = [];
  let i = zip.length - 22;
  while (i > 0 && zip.readUInt32LE(i) !== 0x06054b50) i--;
  let off = zip.readUInt32LE(i + 16);
  const count = zip.readUInt16LE(i + 10);
  for (let k = 0; k < count; k++) { const n = zip.readUInt16LE(off + 28), m = zip.readUInt16LE(off + 30), c = zip.readUInt16LE(off + 32); names.push(zip.slice(off + 46, off + 46 + n).toString()); off += 46 + n + m + c; }
  return names;
};

beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({})]);
  org = await User.create({ fullName: 'Org', email: 'o@x.com', role: Role.ORGANIZER, isActive: true });
  other = await User.create({ fullName: 'Other', email: 'p@x.com', role: Role.ORGANIZER, isActive: true });
  cat = await Category.create({ name: 'Corporate', isActive: true });
});

describe('zip sizes', () => {
  const { zipSizes } = require('../src/services/cardDownload.service');
  it('uses as few zips as the 100 limit allows and fills them evenly', () => {
    expect(zipSizes(0)).toEqual([]);
    expect(zipSizes(1)).toEqual([1]);
    expect(zipSizes(100)).toEqual([100]);
    expect(zipSizes(101)).toEqual([51, 50]);
    expect(zipSizes(150)).toEqual([75, 75]);
    expect(zipSizes(250)).toEqual([84, 83, 83]);
    expect(zipSizes(1000)).toEqual(Array(10).fill(100));
    for (const n of [1, 99, 100, 101, 199, 200, 201, 999, 1000, 1001, 5000]) {
      const sizes: number[] = zipSizes(n);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });
});

describe('printable card download', () => {
  const plan = (ev: any, who: any, ids: string[]) => request(app).post(`/api/v1/events/${ev._id}/invitation-cards/plan`).set(auth(who)).send({ inviteeIds: ids });
  const part = (ev: any, who: any, planId: string, n: number) => request(app).post(`/api/v1/events/${ev._id}/invitation-cards/download`).set(auth(who)).send({ planId, part: n }).buffer(true).parse(binary);

  it('plans the selected guests, then each part holds its own guests as PDFs with a pass printed on every card', async () => {
    const ev: any = await mkEvent('PRINT');
    const guests: any[] = await mkGuests(ev, 5);
    const ids = guests.map((g) => String(g._id));
    const p = await plan(ev, org, ids);
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ total: 5, zips: 1, sizes: [5] });

    const one = await part(ev, org, p.body.data.planId, 1);
    expect(one.status).toBe(200);
    expect(one.headers['content-type']).toContain('application/zip');
    expect(one.headers['content-disposition']).toContain('Gala-Night-cards-1-of-1.zip');
    expect(entries(one.body as Buffer)).toEqual(['0001-Guest-1.pdf', '0002-Guest-2.pdf', '0003-Guest-3.pdf', '0004-Guest-4.pdf', '0005-Guest-5.pdf']);
    expect((one.body as Buffer).includes(Buffer.from('%PDF-1.7'))).toBe(true);

    // every guest got an entry pass, but nobody was marked as invited
    const after: any[] = await Invitee.find({ eventId: ev._id }).select('+qrTokenCipher');
    expect(after.every((g) => g.qrTokenHash && g.invitationStatus === 'PENDING')).toBe(true);
    // a second download reuses the passes (the QR on the card does not change)
    const before = after.find((g) => g.name === 'Guest 1').qrTokenHash;
    await part(ev, org, p.body.data.planId, 1);
    expect((await Invitee.findOne({ eventId: ev._id, name: 'Guest 1' }))!.qrTokenHash).toBe(before);
    // only the ticked guests get cards
    const some = await plan(ev, org, ids.slice(0, 2));
    expect(some.body.data).toMatchObject({ total: 2, sizes: [2] });
  });

  it('splits a large selection evenly across zips of at most 100, with no guest in two zips', async () => {
    const ev: any = await mkEvent('PRINT');
    const guests: any[] = await mkGuests(ev, 101);
    const p = await plan(ev, org, guests.map((g) => String(g._id)));
    expect(p.body.data).toMatchObject({ total: 101, zips: 2, sizes: [51, 50] });
    const second = await part(ev, org, p.body.data.planId, 2);
    const names = entries(second.body as Buffer);
    expect(names).toHaveLength(50);
    expect(names[0]).toBe('0052-Guest-52.pdf');
    const missing = await part(ev, org, p.body.data.planId, 3);
    expect(missing.status).toBe(400);
  });

  it('needs selected guests, an event set to print, the owner, and a live plan', async () => {
    const digital: any = await mkEvent('DIGITAL');
    const print: any = await mkEvent('BOTH');
    const g: any[] = await mkGuests(print, 1);
    const ids = [String(g[0]._id)];
    expect((await plan(print, org, [])).status).toBe(400);
    expect((await plan(digital, org, ids)).status).toBe(409);
    expect((await plan(print, other, ids)).status).toBe(404);
    const p = await plan(print, org, ids);
    // a plan belongs to the person who made it
    const stolen = await request(app).post(`/api/v1/events/${print._id}/invitation-cards/download`).set(auth(other)).send({ planId: p.body.data.planId, part: 1 });
    expect(stolen.status).toBe(404);
    // the system decides the split: a number of guests per zip is not accepted as an input
    const get = await request(app).get(`/api/v1/events/${print._id}/invitation-cards/download?planId=${p.body.data.planId}&part=1`).set(auth(org)).buffer(true).parse(binary);
    expect(get.status).toBe(200);
  });
});
