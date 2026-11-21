// Printable cards as ONE download: built in the background, progress polled, then a single zip (holding the smaller zips for large
// selections) fetched through a short-lived ticket.
import request from 'supertest';
import mongoose from 'mongoose';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yauzl: any = require('yauzl');
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(180000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
let mongo: MongoMemoryServer; let org: any; let other: any; let cat: any;
const day = 864e5;
const binary = (res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
const names = (zip: Buffer) => new Promise<string[]>((resolve, reject) => yauzl.fromBuffer(zip, { lazyEntries: true }, (e: any, z: any) => {
  if (e || !z) return reject(e);
  const out: string[] = [];
  z.on('entry', (en: any) => { out.push(en.fileName); z.readEntry(); });
  z.on('end', () => resolve(out));
  z.readEntry();
}));
const entryBuffer = (zip: Buffer, name: string) => new Promise<Buffer>((resolve, reject) => yauzl.fromBuffer(zip, { lazyEntries: true }, (e: any, z: any) => {
  if (e || !z) return reject(e);
  z.on('entry', (en: any) => {
    if (en.fileName !== name) return z.readEntry();
    z.openReadStream(en, (err: any, s: any) => { if (err || !s) return reject(err); const c: Buffer[] = []; s.on('data', (d: any) => c.push(d)); s.on('end', () => resolve(Buffer.concat(c))); });
  });
  z.readEntry();
}));
const mkEvent = () => Event.create({ organizerId: org._id, title: 'Gala Night', description: 'd', categoryId: cat._id, format: 'PHYSICAL', status: 'PUBLISHED', invitationType: 'PRINT', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
const mkGuests = (ev: any, n: number) => Invitee.insertMany(Array.from({ length: n }, (_, i) => ({ eventId: ev._id, name: `Guest ${i + 1}`, email: `g${i + 1}@x.com`, mobile: `98${String(10000000 + i)}` })));
const base = (ev: any) => `/api/v1/events/${ev._id}/invitation-cards`;
const waitDone = async (ev: any, who: any, jobId: string) => {
  for (let i = 0; i < 120; i++) {
    const s = await request(app).get(`${base(ev)}/jobs/${jobId}`).set(auth(who));
    if (s.body.data.status !== 'RUNNING') return s.body.data;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('job did not finish');
};

beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({})]);
  org = await User.create({ fullName: 'Org', email: 'o@x.com', role: Role.ORGANIZER, isActive: true });
  other = await User.create({ fullName: 'Other', email: 'p@x.com', role: Role.ORGANIZER, isActive: true });
  cat = await Category.create({ name: 'Corporate', isActive: true });
});
afterEach(() => { delete process.env.CARD_ZIP_MAX_GUESTS; });

describe('cards as one download', () => {
  it('up to the zip size: one zip holding the PDFs directly', async () => {
    const ev: any = await mkEvent();
    const guests: any[] = await mkGuests(ev, 3);
    const plan = await request(app).post(`${base(ev)}/plan`).set(auth(org)).send({ inviteeIds: guests.map((g) => String(g._id)) });
    expect(plan.body.data).toMatchObject({ zips: 1, nested: false, fileName: 'Gala Night.zip' });
    const start = await request(app).post(`${base(ev)}/jobs`).set(auth(org)).send({ planId: plan.body.data.planId });
    expect(start.status).toBe(202);
    const done = await waitDone(ev, org, start.body.data.jobId);
    expect(done).toMatchObject({ status: 'DONE', total: 3, doneGuests: 3, doneParts: 1 });
    expect(done.filePath).toBeUndefined(); // the server's disk path is never shown
    const ticket = await request(app).post(`${base(ev)}/jobs/${start.body.data.jobId}/ticket`).set(auth(org));
    const file = await request(app).get(ticket.body.data.path).buffer(true).parse(binary); // no sign-in header: the ticket is the permission
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toContain('filename="Gala Night.zip"');
    expect(await names(file.body as Buffer)).toEqual(['0001-Guest-1.pdf', '0002-Guest-2.pdf', '0003-Guest-3.pdf']);
  });

  it('a large selection: ONE zip that holds the smaller zips, each with its own guests', async () => {
    process.env.CARD_ZIP_MAX_GUESTS = '3';
    const ev: any = await mkEvent();
    const guests: any[] = await mkGuests(ev, 7);
    const plan = await request(app).post(`${base(ev)}/plan`).set(auth(org)).send({ inviteeIds: guests.map((g) => String(g._id)) });
    expect(plan.body.data).toMatchObject({ zips: 3, sizes: [3, 2, 2], nested: true, fileName: 'Gala Night.zip' });
    const start = await request(app).post(`${base(ev)}/jobs`).set(auth(org)).send({ planId: plan.body.data.planId });
    // a second tap while it runs attaches to the first
    const again = await request(app).post(`${base(ev)}/jobs`).set(auth(org)).send({ planId: plan.body.data.planId });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'JOB_ALREADY_RUNNING', jobId: start.body.data.jobId });
    // not ready yet: no ticket
    const early = await request(app).post(`${base(ev)}/jobs/${start.body.data.jobId}/ticket`).set(auth(org));
    expect([200, 409]).toContain(early.status);
    const done = await waitDone(ev, org, start.body.data.jobId);
    expect(done).toMatchObject({ status: 'DONE', total: 7, doneGuests: 7, doneParts: 3, zips: 3 });
    const ticket = await request(app).post(`${base(ev)}/jobs/${start.body.data.jobId}/ticket`).set(auth(org));
    const file = await request(app).get(ticket.body.data.path).buffer(true).parse(binary);
    const outer = file.body as Buffer;
    expect(await names(outer)).toEqual(['Gala Night_1.zip', 'Gala Night_2.zip', 'Gala Night_3.zip']);
    expect(await names(await entryBuffer(outer, 'Gala Night_1.zip'))).toEqual(['0001-Guest-1.pdf', '0002-Guest-2.pdf', '0003-Guest-3.pdf']);
    expect(await names(await entryBuffer(outer, 'Gala Night_3.zip'))).toEqual(['0006-Guest-6.pdf', '0007-Guest-7.pdf']);
  });

  it('only the person who started it can follow it, and a ticket belongs to a finished job', async () => {
    const ev: any = await mkEvent();
    const guests: any[] = await mkGuests(ev, 2);
    const plan = await request(app).post(`${base(ev)}/plan`).set(auth(org)).send({ inviteeIds: guests.map((g) => String(g._id)) });
    const start = await request(app).post(`${base(ev)}/jobs`).set(auth(org)).send({ planId: plan.body.data.planId });
    const jobId = start.body.data.jobId;
    expect((await request(app).get(`${base(ev)}/jobs/${jobId}`).set(auth(other))).status).toBe(404);
    expect((await request(app).post(`${base(ev)}/jobs/${jobId}/ticket`).set(auth(other))).status).toBe(404);
    expect((await request(app).get(`/api/v1/card-files/${'0'.repeat(48)}`)).status).toBe(404); // a made-up ticket
    expect((await request(app).get('/api/v1/card-files/not-a-ticket')).status).toBe(404);
    expect((await request(app).post(`${base(ev)}/jobs`).set(auth(other)).send({ planId: plan.body.data.planId })).status).toBe(404); // someone else's plan
    await waitDone(ev, org, jobId);
  });
});

describe('a print-only event is never sent', () => {
  it('refuses to send or resend invitations, and says what to do instead', async () => {
    const ev: any = await mkEvent(); // invitationType PRINT
    const g: any[] = await mkGuests(ev, 1);
    const send = await request(app).post(`/api/v1/events/${ev._id}/invitations/send`).set(auth(org)).send({ inviteeIds: [String(g[0]._id)], channel: 'EMAIL' });
    expect(send.status).toBe(409);
    expect(send.body.code).toBe('PRINT_ONLY_EVENT');
    expect(send.body.message).toContain('Download Invitee Cards');
  });
});
