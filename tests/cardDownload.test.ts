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

describe('printable card download', () => {
  it('plans the zips, then each part holds its own guests as PDFs with a pass printed on every card', async () => {
    const ev: any = await mkEvent('PRINT');
    await mkGuests(ev, 5);
    const plan = await request(app).post(`/api/v1/events/${ev._id}/invitation-cards/plan`).set(auth(org)).send({ perZip: 2 });
    expect(plan.body.data).toEqual({ total: 5, perZip: 2, zips: 3 });

    const one = await request(app).post(`/api/v1/events/${ev._id}/invitation-cards/download`).set(auth(org)).send({ perZip: 2, part: 1 }).buffer(true).parse(binary);
    expect(one.status).toBe(200);
    expect(one.headers['content-type']).toContain('application/zip');
    expect(one.headers['content-disposition']).toContain('Gala-Night-cards-1-of-3.zip');
    const names = entries(one.body as Buffer);
    expect(names).toEqual(['0001-Guest-1.pdf', '0002-Guest-2.pdf']);
    expect((one.body as Buffer).includes(Buffer.from('%PDF-1.7'))).toBe(true);

    const three = await request(app).post(`/api/v1/events/${ev._id}/invitation-cards/download`).set(auth(org)).send({ perZip: 2, part: 3 }).buffer(true).parse(binary);
    expect(entries(three.body as Buffer)).toEqual(['0005-Guest-5.pdf']);

    // every guest got an entry pass, but nobody was marked as invited
    const guests: any[] = await Invitee.find({ eventId: ev._id }).select('+qrTokenCipher');
    expect(guests.filter((g) => g.qrTokenHash).length).toBe(3);
    expect(guests.every((g) => g.invitationStatus === 'PENDING')).toBe(true);
    // a second download of the same part reuses the passes (the QR on the card does not change)
    const before = guests.find((g) => g.name === 'Guest 1').qrTokenHash;
    await request(app).post(`/api/v1/events/${ev._id}/invitation-cards/download`).set(auth(org)).send({ perZip: 2, part: 1 }).buffer(true).parse(binary);
    expect((await Invitee.findOne({ eventId: ev._id, name: 'Guest 1' }))!.qrTokenHash).toBe(before);
  });

  it('is refused for a digital-only event, for another organizer, and for more than 100 per zip', async () => {
    const digital: any = await mkEvent('DIGITAL');
    const print: any = await mkEvent('BOTH');
    await mkGuests(print, 1);
    const a = await request(app).post(`/api/v1/events/${digital._id}/invitation-cards/plan`).set(auth(org)).send({ perZip: 10 });
    expect(a.status).toBe(409);
    const b = await request(app).post(`/api/v1/events/${print._id}/invitation-cards/plan`).set(auth(other)).send({ perZip: 10 });
    expect(b.status).toBe(404);
    const c = await request(app).post(`/api/v1/events/${print._id}/invitation-cards/plan`).set(auth(org)).send({ perZip: 101 });
    expect(c.status).toBe(400);
    const d = await request(app).post(`/api/v1/events/${print._id}/invitation-cards/plan`).set(auth(org)).send({ perZip: 100 });
    expect(d.body.data).toMatchObject({ total: 1, zips: 1 });
  });
});
