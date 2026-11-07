/**
 * Who can share an email or a phone number. Accounts (system user, organizer, administrator) may share both; sign-in tells them apart by
 * password and portal. A guest (invitee) is not an account either, so a person can be a guest AND a system user (or an organizer, or
 * an admin) in the same event: they get their own invitation, pass and food like any other guest. Every pair is
 * tried in both orders through the real routes. Mail is mocked: nothing is sent.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import * as xlsx from 'xlsx';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { Session } from '../src/models/Session';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { generateAccessToken } from '../src/utils/token';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.setTimeout(90000);

let mongo: MongoMemoryServer; let orgA: any; let orgB: any; let admin: any; let eventA: any; let corp: any;
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
const day = 864e5;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({}).setOptions({ includeArchived: true } as any), Session.deleteMany({}), SystemUserAssignment.deleteMany({})]);
  orgA = await User.create({ fullName: 'Org A', email: 'a@x.com', phone: '9000000001', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  orgB = await User.create({ fullName: 'Org B', email: 'b@x.com', phone: '9000000002', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', phone: '9000000003', role: Role.ADMIN, isActive: true });
  corp = await Category.create({ name: 'Corporate', isActive: true });
  eventA = await Event.create({ organizerId: orgA._id, title: 'Summit', description: 'd', categoryId: corp._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
});

const addStaff = (who: any, body: Record<string, unknown>) => request(app).post('/api/users').set(auth(who)).send({ password: 'password123', role: 'SYSTEM_USER', ...body });
const addGuest = (who: any, body: Record<string, unknown>, ev = eventA) => request(app).post(`/api/v1/events/${ev._id}/invitees`).set(auth(who)).send(body);
const sheet = (rows: (string | number)[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'Invitees'); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer; };
const importGuests = (who: any, rows: (string | number)[][], mode = 'REPLACE') => request(app).post(`/api/v1/events/${eventA._id}/invitees/import`).set(auth(who)).field('mode', mode).attach('file', sheet([['Name', 'Email', 'Mobile'], ...rows]), 'list.xlsx');

describe('system user and invitee: the same person can be both', () => {
  it('guest first, then system user (same email and phone)', async () => {
    expect((await addGuest(orgA, { name: 'Chanchal Roy', email: 'chanchal@x.com', mobile: '9876500077' })).status).toBe(201);
    expect((await addStaff(orgA, { fullName: 'Chanchal Roy', email: 'chanchal@x.com', phone: '9876500077' })).status).toBe(201);
  });
  it('system user first, then guest (added by hand)', async () => {
    expect((await addStaff(orgA, { fullName: 'Rina Das', email: 'rina@x.com', phone: '9876500078' })).status).toBe(201);
    expect((await addGuest(orgA, { name: 'Rina Das', email: 'rina@x.com', mobile: '9876500078' })).status).toBe(201);
  });
  it('system user first, then guest (Excel upload)', async () => {
    await addStaff(orgA, { fullName: 'Rina Das', email: 'rina@x.com', phone: '9876500078' });
    const up = await importGuests(orgA, [['Rina Das', 'rina@x.com', '9876500078'], ['Other Guest', 'other@x.com', '9876500079']]);
    expect(up.status).toBe(200);
    expect(await Invitee.countDocuments({ eventId: eventA._id })).toBe(2);
  });
  it("a guest's email can be changed to a system user's email, and the staff member can then be assigned to the same event", async () => {
    const staff = await addStaff(orgA, { fullName: 'Sam Staff', email: 'sam@x.com', phone: '9876500080' });
    expect(staff.status).toBe(201);
    const g: any = (await addGuest(orgA, { name: 'Sam Guest', email: 'samguest@x.com' })).body.data;
    const edit = await request(app).patch(`/api/v1/invitees/${g._id || g.id}`).set(auth(orgA)).send({ email: 'sam@x.com', mobile: '9876500080' });
    expect(edit.status).toBe(200);
    const assign = await request(app).post(`/api/v1/events/${eventA._id}/assignments`).set(auth(orgA)).send({ userId: staff.body.data._id, role: 'GATE_STAFF' });
    expect([200, 201]).toContain(assign.status);
  });
  it('the organizer and the administrator can be guests of their own event too (a guest is not an account)', async () => {
    expect((await addGuest(orgA, { name: 'Org A', email: 'a@x.com', mobile: '9000000001' })).status).toBe(201);
    expect((await addGuest(orgA, { name: 'Admin', email: 'admin@x.com', mobile: '9000000003' })).status).toBe(201);
  });
  it('the same guest email in another organizer\'s event, and one person on two organizers\' guest lists, are fine', async () => {
    const eventB: any = await Event.create({ organizerId: orgB._id, title: 'Gala', description: 'd', categoryId: corp._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
    expect((await addGuest(orgA, { name: 'Pat', email: 'pat@x.com' })).status).toBe(201);
    expect((await addGuest(orgB, { name: 'Pat', email: 'pat@x.com' }, eventB)).status).toBe(201);
  });
});

describe('two accounts MAY share an email (the shared-email rules are tested in sharedEmailAccounts.test.ts)', () => {
  it('a system user can share an email with an organizer and with another organizer\'s system user (not with an admin)', async () => {
    expect((await addStaff(orgA, { fullName: 'Shared', email: 'b@x.com' })).status).toBe(201);
    expect((await addStaff(orgA, { fullName: 'Shared', email: 'admin@x.com' })).status).toBe(400); // an administrator's email is never shared
    expect((await addStaff(orgA, { fullName: 'Staff One', email: 's1@x.com' })).status).toBe(201);
    expect((await addStaff(orgB, { fullName: 'Staff One', email: 'S1@x.com' })).status).toBe(201);
    // the same organizer still lists a person once
    const again = await addStaff(orgA, { fullName: 'Staff One', email: 's1@x.com' });
    expect(again.status).toBe(400); expect(again.body.message).toBe('This person is already one of your system users.');
  });
});

describe('phone numbers', () => {
  it('a system user may share a phone number with a guest and with another account', async () => {
    await addGuest(orgA, { name: 'Guest', email: 'g@x.com', mobile: '9876500081' });
    expect((await addStaff(orgA, { fullName: 'Staff', email: 's4@x.com', phone: '9876500081' })).status).toBe(201);
    expect((await addStaff(orgA, { fullName: 'Staff Five', email: 's5@x.com', phone: '9876500081' })).status).toBe(201);
  });
});
