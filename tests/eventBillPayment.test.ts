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
  await Promise.all([User.deleteMany({}), Category.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({}), Order.deleteMany({})]);
  org = await User.create({ fullName: 'Org', email: 'o@x.com', role: Role.ORGANIZER, isActive: true });
  other = await User.create({ fullName: 'Other', email: 'p@x.com', role: Role.ORGANIZER, isActive: true });
  const cat = await Category.create({ name: 'Corporate', isActive: true });
  ev = await Event.create({ organizerId: org._id, title: 'Summit', description: 'd', categoryId: cat._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) }, pricing: { ratePerInvitee: 3, currency: 'INR', lockedAt: new Date() } });
});
afterEach(() => jest.restoreAllMocks());

describe('event bill payment', () => {
  it('lists what is due, pays it, issues an invoice, and only the new invitations are due afterwards', async () => {
    await sendTo(4);
    let res = await request(app).get('/api/v1/billing/events').set(auth(org));
    expect(res.body.data.totalDue).toBe(12);
    expect(res.body.data.events[0]).toMatchObject({ invitesSent: 4, due: 12, dueInvitees: 4 });

    const spy = stubRazorpay();
    const pay = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id) });
    expect(pay.status).toBe(201);
    expect(pay.body.data).toMatchObject({ keyId: 'rzp_test_key', amount: 1200, currency: 'INR', invitees: 4 });
    expect(JSON.parse((spy.mock.calls[0][1] as any).body).amount).toBe(1200);
    expect(JSON.stringify(pay.body)).not.toContain('rzp_test_secret');

    const orderId = pay.body.data.providerOrderId;
    const bad = await request(app).post('/api/v1/payments/verify').set(auth(org)).send({ providerOrderId: orderId, providerPaymentId: 'pay_1', signature: 'nope' });
    expect(bad.status).toBe(400);
    // a failed confirmation leaves nothing paid
    res = await request(app).get('/api/v1/billing/events').set(auth(org));
    expect(res.body.data.totalDue).toBe(12);

    const pay2 = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id) });
    const o2 = pay2.body.data.providerOrderId;
    const ok = await request(app).post('/api/v1/payments/verify').set(auth(org)).send({ providerOrderId: o2, providerPaymentId: 'pay_2', signature: sign(o2, 'pay_2') });
    expect(ok.status).toBe(200);
    expect(ok.body.data.invoice.invitees).toBe(4);

    res = await request(app).get('/api/v1/billing/events').set(auth(org));
    expect(res.body.data).toMatchObject({ totalDue: 0, totalPaid: 12 });
    const dup = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id) });
    expect(dup.status).toBe(409);

    await sendTo(2);
    res = await request(app).get('/api/v1/billing/events').set(auth(org));
    expect(res.body.data.events[0]).toMatchObject({ due: 6, dueInvitees: 2, paid: 12 });

    const inv = await request(app).get('/api/v1/billing/invoices').set(auth(org));
    expect(inv.body.data).toHaveLength(1);
    expect(inv.body.data[0]).toMatchObject({ eventName: 'Summit', invitees: 4, amount: 12 });
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

    await Event.updateOne({ _id: ev._id }, { $set: { 'pricing.ratePerInvitee': null } });
    const norate = await request(app).post('/api/v1/billing/pay').set(auth(org)).send({ eventId: String(ev._id) });
    expect(norate.status).toBe(409);
  });
});
