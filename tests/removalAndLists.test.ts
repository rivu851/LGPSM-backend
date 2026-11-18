// Deleting an invitee asks for a reason that can be sent to the guest (email / WhatsApp), and an uploaded list with no guests left can be
// deleted while its record stays as history.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mockSendEmail = jest.fn().mockResolvedValue(true);
jest.mock('../src/utils/email.provider', () => ({ sendEmail: (...args: any[]) => mockSendEmail(...args) }));

import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { InviteeSet, ImportMode } from '../src/models/InviteeSet';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
let mongo: MongoMemoryServer; let org: any; let ev: any;
const day = 864e5;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  mockSendEmail.mockClear();
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({}).setOptions({ includeArchived: true } as any), InviteeSet.deleteMany({})]);
  org = await User.create({ fullName: 'Org', email: 'o@x.com', role: Role.ORGANIZER, isActive: true });
  const cat = await Category.create({ name: 'Corporate', isActive: true });
  ev = await Event.create({ organizerId: org._id, title: 'Summit', description: 'd', categoryId: cat._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
});

describe('deleting an invitee with a reason', () => {
  it('sends the reason by email when asked, and says what happened', async () => {
    const g: any = await Invitee.create({ eventId: ev._id, name: 'Guest One', email: 'g1@x.com', mobile: '9876543210' });
    const res = await request(app).delete(`/api/v1/invitees/${g._id}`).set(auth(org)).send({ reason: 'Venue capacity changed', notify: { email: true, whatsapp: false } });
    expect(res.status).toBe(200);
    expect(res.body.data.notice.email).toBe('SENT');
    expect(res.body.data.notice.whatsapp).toBe('SKIPPED');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(String(mockSendEmail.mock.calls[0][2])).toContain('Venue capacity changed');
    expect(await Invitee.findById(g._id)).toBeNull();
  });

  it('says WhatsApp is unavailable when no template is configured, without failing the delete', async () => {
    const g: any = await Invitee.create({ eventId: ev._id, name: 'Guest Two', email: 'g2@x.com', mobile: '9876543211' });
    const res = await request(app).delete(`/api/v1/invitees/${g._id}`).set(auth(org)).send({ reason: 'Not on the final list', notify: { email: false, whatsapp: true } });
    expect(res.status).toBe(200);
    expect(res.body.data.notice.whatsapp).toBe('UNAVAILABLE');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('asks for a reason when a channel is chosen, and still deletes without any message when none is', async () => {
    const g: any = await Invitee.create({ eventId: ev._id, name: 'Guest Three', email: 'g3@x.com' });
    expect((await request(app).delete(`/api/v1/invitees/${g._id}`).set(auth(org)).send({ notify: { email: true } })).status).toBe(400);
    expect(await Invitee.findById(g._id)).not.toBeNull();
    const res = await request(app).delete(`/api/v1/invitees/${g._id}`).set(auth(org));
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('deleting and renaming an uploaded list', () => {
  const sets = (id: string) => `/api/v1/events/${id}/invitees/sets`;
  it('deletes an open list with its never-contacted guests, and keeps the list as history', async () => {
    const set: any = await InviteeSet.create({ eventId: ev._id, name: 'guests.xlsx', mode: ImportMode.APPEND, createdBy: org._id, importedCount: 1 });
    const g: any = await Invitee.create({ eventId: ev._id, name: 'Guest', email: 'g@x.com', inviteeSetId: set._id });
    const ok = await request(app).delete(`${sets(String(ev._id))}/${set._id}`).set(auth(org));
    expect(ok.status).toBe(200);
    expect(ok.body.data.guestsRemoved).toBe(1);
    expect(await Invitee.findById(g._id)).toBeNull();
    const listing = await request(app).get(sets(String(ev._id))).set(auth(org));
    expect(listing.body.data.sets.some((s: any) => s.id === String(set._id))).toBe(false);
    expect(listing.body.data.removedLists).toHaveLength(1);
    expect(listing.body.data.removedLists[0].name).toBe('guests.xlsx');
  });

  it('refuses a locked list (an invitation was sent from it), for delete and for rename', async () => {
    const set: any = await InviteeSet.create({ eventId: ev._id, name: 'sent.xlsx', mode: ImportMode.APPEND });
    await Invitee.create({ eventId: ev._id, name: 'Sent Guest', email: 's@x.com', inviteeSetId: set._id, invitationStatus: 'SENT' });
    const del = await request(app).delete(`${sets(String(ev._id))}/${set._id}`).set(auth(org));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('SET_LOCKED');
    expect((await request(app).patch(`${sets(String(ev._id))}/${set._id}`).set(auth(org)).send({ name: 'x' })).status).toBe(409);
    expect(await Invitee.countDocuments({ eventId: ev._id })).toBe(1);
  });

  it('renames an open list and refuses an empty name', async () => {
    const set: any = await InviteeSet.create({ eventId: ev._id, name: 'old.xlsx', mode: ImportMode.APPEND });
    expect((await request(app).patch(`${sets(String(ev._id))}/${set._id}`).set(auth(org)).send({ name: '  ' })).status).toBe(400);
    const ok = await request(app).patch(`${sets(String(ev._id))}/${set._id}`).set(auth(org)).send({ name: 'VIP list' });
    expect(ok.status).toBe(200);
    expect((await InviteeSet.findById(set._id) as any).name).toBe('VIP list');
  });

  it('is not available to another organizer', async () => {
    const other = await User.create({ fullName: 'Other', email: 'x@x.com', role: Role.ORGANIZER, isActive: true });
    const set: any = await InviteeSet.create({ eventId: ev._id, name: 'l.xlsx', mode: ImportMode.APPEND });
    expect((await request(app).delete(`${sets(String(ev._id))}/${set._id}`).set(auth(other))).status).toBe(404);
  });
});
