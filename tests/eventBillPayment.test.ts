// An organizer pays for the invitations sent on an event through Razorpay: due = sent x locked rate - already paid.
// The Razorpay API is stubbed; no network call or real charge happens.
import request from 'supertest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { Order } from '../src/models/Order';
import { PlatformSettings } from '../src/models/PlatformSettings';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
let mongo: MongoMemoryServer; let org: any; let other: any; let ev: any; let n = 0;
const day = 864e5;
const stubRazorpay = () => jest.spyOn(global, 'fetch').mockImplementation(async (_u: any, init: any) => {
  const body = JSON.parse(init.body);
  return { ok: true, json: async () => ({ id: `order_test_${++n}`, entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt }) } as any;
});
const sign = (orderId: string, payId: string) => crypto.createHmac('sha256', 'rzp_test_secret').update(`${orderId}|${payId}`).digest('hex');
const sendTo = (count: number) => Invitee.insertMany(Array.from({ length: count }, (_, i) => ({ eventId: ev._id, name: `G${n}${i}`, email: `g${n}${i}@x.com`, mobile: `98765${String(10000 + n * 100 + i).slice(-5)}`, invitationStatus: 'SENT' })));

beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({}), Order.deleteMany({}), PlatformSettings.deleteMany({})]);
  org = await User.create({ fullName: 'Org', email: 'o@x.com', role: Role.ORGANIZER, isActive: true });
  other = await User.create({ fullName: 'Other', email: 'p@x.com', role: Role.ORGANIZER, isActive: true });
  const cat = await Category.create({ name: 'Corporate', isActive: true });
  ev = await Event.create({ organizerId: org._id, title: 'Summit', description: 'd', categoryId: cat._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) }, pricing: { ratePerInvitee: 3, currency: 'INR', lockedAt: new Date() } });
});
afterEach(() => jest.restoreAllMocks());

describe('bill for sending to chosen guests', () => {
  const pending = (count: number) => Invitee.insertMany(Array.from({ length: count }, (_, i) => ({ eventId: ev._id, name: `P${n}${i}`, email: `p${n}${i}@x.com`, mobile: `98000${String(10000 + n * 100 + i).slice(-5)}` })));

  it('quotes invitees x rate + GST, follows the admin GST, and uses prepaid invitations first', async () => {
    const guests: any[] = await pending(5);
    const ids = guests.map((g) => String(g._id));
    let q = await request(app).post('/api/v1/billing/quote').set(auth(org)).send({ eventId: String(ev._id), inviteeIds: ids });
    expect(q.body.data).toMatchObject({ invitees: 5, rate: 3, subtotal: 15, gstPercent: 18, tax: 2.7, total: 17.7, payable: true });

    const admin = await User.create({ fullName: 'Admin', email: 'a@x.com', role: Role.ADMIN, isActive: true });
    const g = await request(app).put('/api/v1/settings/gst').set(auth(admin)).send({ gstPercent: 5 });
    expect(g.status).toBe(200);
    q = await request(app).post('/api/v1/billing/quote').set(auth(org)).send({ eventId: String(ev._id), inviteeIds: ids });
    expect(q.body.data).toMatchObject({ subtotal: 15, gstPercent: 5, tax: 0.75, total: 15.75 });
    const org2 = await request(app).put('/api/v1/settings/gst').set(auth(org)).send({ gstPercent: 0 });
    expect(org2.status).toBe(403);

    stubRazorpay();
    const pay = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id), inviteeIds: ids });
    expect(pay.body.data).toMatchObject({ amount: 1575, invitees: 5, total: 15.75 });
    const o = pay.body.data.providerOrderId;
    await request(app).post('/api/v1/payments/verify').set(auth(org)).send({ providerOrderId: o, providerPaymentId: 'pay_x', signature: sign(o, 'pay_x') });

    // paid for 5, none sent yet: asking again for the same guests costs nothing
    q = await request(app).post('/api/v1/billing/quote').set(auth(org)).send({ eventId: String(ev._id), inviteeIds: ids });
    expect(q.body.data).toMatchObject({ invitees: 0, total: 0, alreadyPaid: 5, payable: false });
    // once they are sent, nothing is due
    await Invitee.updateMany({ _id: { $in: ids } }, { $set: { invitationStatus: 'SENT' } });
    const bills = await request(app).get('/api/v1/billing/events').set(auth(org));
    expect(bills.body.data.totalDue).toBe(0);
  });
});

describe('an event created before any rate was set', () => {
  it('is billed at the admin\'s current rate, which is then kept on the event', async () => {
    await Event.updateOne({ _id: ev._id }, { $unset: { pricing: '' } });
    const g: any = await Invitee.create({ eventId: ev._id, name: 'Late', email: 'late@x.com', mobile: '9811122233' });
    let q = await request(app).post('/api/v1/billing/quote').set(auth(org)).send({ eventId: String(ev._id), inviteeIds: [String(g._id)] });
    expect(q.body.data).toMatchObject({ payable: false, total: 0 }); // no rate set by anyone: nothing to charge

    await PlatformSettings.updateOne({ key: 'global' }, { $set: { 'pricing.ratePerInvitee': 4 } }, { upsert: true });
    q = await request(app).post('/api/v1/billing/quote').set(auth(org)).send({ eventId: String(ev._id), inviteeIds: [String(g._id)] });
    expect(q.body.data).toMatchObject({ payable: true, rate: 4, subtotal: 4, total: 4.72 }); // the admin's rate wins over the default
    const stored: any = await Event.findById(ev._id).lean();
    expect(stored.pricing.ratePerInvitee).toBe(4);

    // a later change of the platform rate does not move this event
    await PlatformSettings.updateOne({ key: 'global' }, { $set: { 'pricing.ratePerInvitee': 9 } });
    q = await request(app).post('/api/v1/billing/quote').set(auth(org)).send({ eventId: String(ev._id), inviteeIds: [String(g._id)] });
    expect(q.body.data).toMatchObject({ rate: 4, total: 4.72 });
  });
});

describe('a rate set for one organizer', () => {
  it('overrides the platform rate for that organizer only, and only an admin can set it', async () => {
    await PlatformSettings.updateOne({ key: 'global' }, { $set: { 'pricing.ratePerInvitee': 1 } }, { upsert: true });
    const g: any = await Invitee.create({ eventId: ev._id, name: 'One', email: 'one@x.com', mobile: '9811100011' });
    const body = { eventId: String(ev._id), inviteeIds: [String(g._id)] };
    let q = await request(app).post('/api/v1/billing/quote').set(auth(org)).send(body);
    expect(q.body.data).toMatchObject({ rate: 3 }); // this event locked 3 when it was created

    const admin = await User.create({ fullName: 'Admin', email: 'a2@x.com', role: Role.ADMIN, isActive: true });
    const denied = await request(app).put(`/api/users/${org._id}/rate`).set(auth(org)).send({ ratePerInvitee: 9 });
    expect(denied.status).toBe(403);
    const set = await request(app).put(`/api/users/${org._id}/rate`).set(auth(admin)).send({ ratePerInvitee: 5 });
    expect(set.body.data).toMatchObject({ customRate: 5, defaultRate: 1, effectiveRate: 5 });
    q = await request(app).post('/api/v1/billing/quote').set(auth(org)).send(body);
    expect(q.body.data).toMatchObject({ rate: 5, subtotal: 5, total: 5.9 });
    q = await request(app).post('/api/v1/billing/quote').set(auth(other)).send({ eventId: String(ev._id), inviteeIds: [String(g._id)] });
    expect(q.status).toBe(404); // not their event

    const cleared = await request(app).put(`/api/users/${org._id}/rate`).set(auth(admin)).send({ ratePerInvitee: null });
    expect(cleared.body.data).toMatchObject({ customRate: null, effectiveRate: 1 });
  });

  it('a new event takes the organizer rate, else the platform rate', async () => {
    await PlatformSettings.updateOne({ key: 'global' }, { $set: { 'pricing.ratePerInvitee': 1 } }, { upsert: true });
    const admin = await User.create({ fullName: 'Admin', email: 'a3@x.com', role: Role.ADMIN, isActive: true });
    const cat: any = await Category.findOne({});
    const mk = async (organizerId: any) => (await request(app).post('/api/v1/events').set(auth(admin)).send({
      title: 'New event', description: 'd', categoryId: String(cat._id), format: 'PHYSICAL', contactNumber: '9007000891', organizerIds: [String(organizerId)],
      location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + 3 * day), end: new Date(Date.now() + 4 * day) }
    }));
    const a = await mk(org._id);
    if (a.status === 201 || a.status === 200) {
      const created: any = await Event.findOne({ title: 'New event' }).lean();
      expect(created.pricing.ratePerInvitee).toBe(1);
    }
  });
});

describe('event bill payment', () => {
  it('lists what is due, pays it, issues an invoice, and only the new invitations are due afterwards', async () => {
    await sendTo(4);
    let res = await request(app).get('/api/v1/billing/events').set(auth(org));
    expect(res.body.data.totalDue).toBe(14.16); // 4 x 3 = 12, plus 18% GST
    expect(res.body.data.events[0]).toMatchObject({ invitesSent: 4, dueSubtotal: 12, dueTax: 2.16, due: 14.16, dueInvitees: 4, gstPercent: 18 });

    const spy = stubRazorpay();
    const pay = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id) });
    expect(pay.status).toBe(201);
    expect(pay.body.data).toMatchObject({ keyId: 'rzp_test_key', amount: 1416, currency: 'INR', invitees: 4, subtotal: 12, tax: 2.16, total: 14.16 });
    expect(JSON.parse((spy.mock.calls[0][1] as any).body).amount).toBe(1416);
    expect(JSON.stringify(pay.body)).not.toContain('rzp_test_secret');

    const orderId = pay.body.data.providerOrderId;
    const bad = await request(app).post('/api/v1/payments/verify').set(auth(org)).send({ providerOrderId: orderId, providerPaymentId: 'pay_1', signature: 'nope' });
    expect(bad.status).toBe(400);
    // a failed confirmation leaves nothing paid
    res = await request(app).get('/api/v1/billing/events').set(auth(org));
    expect(res.body.data.totalDue).toBe(14.16);

    const pay2 = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id) });
    const o2 = pay2.body.data.providerOrderId;
    const ok = await request(app).post('/api/v1/payments/verify').set(auth(org)).send({ providerOrderId: o2, providerPaymentId: 'pay_2', signature: sign(o2, 'pay_2') });
    expect(ok.status).toBe(200);
    expect(ok.body.data.invoice.invitees).toBe(4);

    res = await request(app).get('/api/v1/billing/events').set(auth(org));
    expect(res.body.data).toMatchObject({ totalDue: 0, totalPaid: 14.16 });
    const dup = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id) });
    expect(dup.status).toBe(409);

    await sendTo(2);
    res = await request(app).get('/api/v1/billing/events').set(auth(org));
    expect(res.body.data.events[0]).toMatchObject({ due: 7.08, dueInvitees: 2, paid: 14.16 });

    const inv = await request(app).get('/api/v1/billing/invoices').set(auth(org));
    expect(inv.body.data).toHaveLength(1);
    expect(inv.body.data[0]).toMatchObject({ eventName: 'Summit', invitees: 4, subtotal: 12, tax: 2.16, amount: 14.16 });
  });

  it('refuses another organizer, a missing rate, and unconfigured payments', async () => {
    await sendTo(2);
    stubRazorpay();
    const foreign = await request(app).post('/api/v1/billing/pay').set(auth(other)).send({ eventId: String(ev._id) });
    expect(foreign.status).toBe(404);

    delete process.env.RAZORPAY_KEY_ID;
    const off = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id) });
    expect(off.status).toBe(503);
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';

    // no rate stored on the event and none set by the administrator: nothing to pay
    await Event.updateOne({ _id: ev._id }, { $set: { 'pricing.ratePerInvitee': null } });
    const norate = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id) });
    expect(norate.status).toBe(409);
  });
});
