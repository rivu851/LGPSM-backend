// A new session starts with only the guests uploaded or chosen for it: guests with no session rules (allowed everywhere) must not be pulled
// into it just because it was created.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { Session } from '../src/models/Session';
import { generateAccessToken } from '../src/utils/token';
import * as xlsx from 'xlsx';

jest.setTimeout(60000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
let mongo: MongoMemoryServer; let org: any; let ev: any;
const day = 864e5;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Session.deleteMany({}), Invitee.deleteMany({}).setOptions({ includeArchived: true } as any)]);
  org = await User.create({ fullName: 'Org', email: 'o@x.com', role: Role.ORGANIZER, isActive: true });
  const cat = await Category.create({ name: 'Corporate', isActive: true });
  ev = await Event.create({ organizerId: org._id, title: 'Summit', description: 'd', categoryId: cat._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 3 * day) } });
});
const newSession = (name: string, extra: object = {}) => request(app).post(`/api/v1/events/${ev._id}/sessions`).set(auth(org)).send({ name, schedule: { start: new Date(Date.now() + day + 3600e3), end: new Date(Date.now() + day + 7200e3) }, ...extra });

describe('creating a session', () => {
  it('does not add guests who were already on the event to it', async () => {
    const first = await newSession('Check In');
    expect(first.status).toBe(201);
    const firstId = first.body.data._id;
    const guest: any = await Invitee.create({ eventId: ev._id, name: 'Old Guest', email: 'old@x.com', mobile: '9876543210' }); // no rules: allowed everywhere

    const second = await newSession('Catering');
    expect(second.status).toBe(201);

    const after: any = await Invitee.findById(guest._id).lean();
    const ids = after.sessionAccess.map((a: any) => String(a.sessionId));
    expect(ids).toEqual([firstId]);       // still in the first session
    expect(ids).not.toContain(second.body.data._id); // not in the new one
  });
});

describe('deleting a session', () => {
  it('leaves a guest who was only in it in no session, not in every session', async () => {
    const a = (await newSession('Check In')).body.data._id;
    const b = (await newSession('Catering')).body.data._id;
    const onlyB: any = await Invitee.create({ eventId: ev._id, name: 'Only B', email: 'b@x.com', mobile: '9876543211', sessionAccess: [{ sessionId: b, allowed: true }] });
    const both: any = await Invitee.create({ eventId: ev._id, name: 'Both', email: 'c@x.com', mobile: '9876543212', sessionAccess: [{ sessionId: a, allowed: true }, { sessionId: b, allowed: true }] });

    const del = await request(app).delete(`/api/v1/sessions/${b}`).set(auth(org));
    expect(del.status).toBe(200);

    const o: any = await Invitee.findById(onlyB._id).lean();
    expect(o.sessionAccess.length).toBeGreaterThan(0);                       // not "allowed everywhere"
    expect(o.sessionAccess.every((x: any) => x.allowed === false)).toBe(true);
    const bo: any = await Invitee.findById(both._id).lean();
    expect(bo.sessionAccess.map((x: any) => String(x.sessionId))).toEqual([a]);
  });
});

describe('changing a session\'s list (edit session > choose file)', () => {
  const sheet = (rows: string[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['Name', 'Email', 'Mobile'], ...rows]), 'Invitees'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };

  it('takes guests who are not in the new file off that session and adds the new ones, without touching other sessions', async () => {
    const a = (await newSession('Check In')).body.data._id;
    const b = (await newSession('Catering')).body.data._id;
    const keep: any = await Invitee.create({ eventId: ev._id, name: 'Keep Me', email: 'keep@x.com', mobile: '9876543201', sessionAccess: [{ sessionId: b, allowed: true }] });
    const drop: any = await Invitee.create({ eventId: ev._id, name: 'Drop Me', email: 'drop@x.com', mobile: '9876543202', sessionAccess: [{ sessionId: b, allowed: true }] });
    const shared: any = await Invitee.create({ eventId: ev._id, name: 'In Both', email: 'both@x.com', mobile: '9876543203', sessionAccess: [{ sessionId: a, allowed: true }, { sessionId: b, allowed: true }] });

    const up = await request(app).post(`/api/v1/events/${ev._id}/invitees/import`).set(auth(org)).field('mode', 'REPLACE').field('sessionId', b)
      .attach('file', sheet([['Keep Me', 'keep@x.com', '9876543201'], ['Brand New', 'new@x.com', '9876543204']]), 'catering.xlsx');
    expect(up.status).toBe(200);

    const idsOf = async (id: any) => ((await Invitee.findById(id).lean()) as any)?.sessionAccess.filter((x: any) => x.allowed).map((x: any) => String(x.sessionId));
    expect(await idsOf(keep._id)).toEqual([b]);
    const fresh: any = await Invitee.findOne({ eventId: ev._id, email: 'new@x.com' }).lean();
    expect(fresh.sessionAccess.map((x: any) => String(x.sessionId))).toEqual([b]);          // new guest is in this session only
    expect(await idsOf(shared._id)).toEqual([a]);                                          // lost this session, kept the other
    // a never-invited guest who only had this session is set aside (no longer on the event list)
    expect(await Invitee.findById(drop._id)).toBeNull();
  });
});
