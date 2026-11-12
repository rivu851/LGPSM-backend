import mongoose from 'mongoose';
import supertest from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { TicketTier } from '../src/models/TicketTier';
import { PlatformSettings } from '../src/models/PlatformSettings';
import { PriceRateChange } from '../src/models/PriceRateChange';
import { generateAccessToken } from '../src/utils/token';
import { PLATFORM_CURRENCY } from '../src/constants/currency';

// The platform bills in rupees. Amounts are never converted and no stored record is rewritten.
const request = supertest(app);
jest.setTimeout(120_000);

describe('INR is the platform currency', () => {
  let mongo: MongoMemoryServer; let admin: any, org: any;
  const bearer = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
  const eventBody = () => ({ title: 'Priced', location: { address: 'Hall' }, schedule: { start: new Date(Date.now() + 3600e3).toISOString(), end: new Date(Date.now() + 7200e3).toISOString() } });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    const mk = (n: string, role: Role) => User.create({ fullName: n, email: `${n.replace(/\W/g, '').toLowerCase()}@cur.test`, role, passwordHash: 'x', isActive: true });
    admin = await mk('Admin One', Role.ADMIN); org = await mk('Org One', Role.ORGANIZER);
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('the constant is INR and a fresh settings record defaults to it', async () => {
    expect(PLATFORM_CURRENCY).toBe('INR');
    const fresh = await PlatformSettings.create({ key: 'fresh-check' });
    expect(fresh.pricing?.currency).toBe('INR');
    await PlatformSettings.deleteOne({ key: 'fresh-check' });
  });

  it('settings written when the default was USD are shown as INR, with the stored record and the amount left exactly as they were', async () => {
    await PlatformSettings.collection.updateOne({ key: 'global' }, { $set: { key: 'global', 'pricing.ratePerInvitee': 12, 'pricing.currency': 'USD' } }, { upsert: true });
    const res = await request.get('/api/v1/settings/pricing').set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('INR');
    expect(res.body.data.ratePerInvitee).toBe(12); // not converted
    const stored: any = await PlatformSettings.collection.findOne({ key: 'global' });
    expect(stored.pricing.currency).toBe('USD'); // not rewritten
    expect(stored.pricing.ratePerInvitee).toBe(12);
  });

  it('a rate change is recorded in INR and older history rows are untouched', async () => {
    const old = await PriceRateChange.collection.insertOne({ previousRate: null, newRate: 5, currency: 'USD', changedBy: admin._id, createdAt: new Date(Date.now() - 86400e3), updatedAt: new Date() });
    const res = await request.put('/api/v1/settings/pricing').set(bearer(admin)).send({ ratePerInvitee: 15 });
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('INR');
    const newest: any = await PriceRateChange.findOne({ newRate: 15 }).lean();
    expect(newest.currency).toBe('INR');
    const kept: any = await PriceRateChange.collection.findOne({ _id: old.insertedId });
    expect(kept.currency).toBe('USD');
    expect(kept.newRate).toBe(5);
  });

  it('a new event locks the rate in INR (the number as set), even if the stored setting says USD', async () => {
    const res = await request.post('/api/v1/events').set(bearer(org)).send(eventBody());
    expect(res.status).toBe(201);
    const ev: any = await Event.findById(res.body.data.eventId).lean();
    expect(ev.pricing.currency).toBe('INR');
    expect(ev.pricing.ratePerInvitee).toBe(15);
  });

  it('an event locked earlier in USD keeps its stored record (no rewrite)', async () => {
    const legacy = await Event.create({ organizerId: org._id, title: 'Legacy', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: 'x', coordinates: [0, 0] } as any, schedule: { start: new Date(), end: new Date(Date.now() + 3600e3) }, pricing: { ratePerInvitee: 9, currency: 'USD', lockedAt: new Date() } as any });
    await request.get('/api/v1/reports/earnings').set(bearer(admin));
    const again: any = await Event.collection.findOne({ _id: legacy._id });
    expect(again.pricing.currency).toBe('USD');
    expect(again.pricing.ratePerInvitee).toBe(9);
  });

  it('the earnings report is in INR with the amounts unchanged', async () => {
    const res = await request.get('/api/v1/reports/earnings').set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('INR');
    const legacy = res.body.data.events.find((e: any) => e.eventTitle === 'Legacy' || e.title === 'Legacy');
    if (legacy) expect(legacy.ratePerInvitee).toBe(9);
  });

  it('a ticket tier is priced in INR by default and another currency is refused', async () => {
    const ev = await Event.findOne({ title: 'Priced' });
    const ok = await request.post(`/api/v1/events/${ev!._id}/tickets`).set(bearer(org)).send({ name: 'General', price: 199.99, capacity: 50 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.currency).toBe('INR');
    expect((await request.post(`/api/v1/events/${ev!._id}/tickets`).set(bearer(org)).send({ name: 'Dollar', price: 5, capacity: 5, currency: 'USD' })).status).toBe(400);
    expect(await TicketTier.countDocuments({ name: 'Dollar' })).toBe(0);
    expect((await request.patch(`/api/v1/tickets/${ok.body.data._id}`).set(bearer(org)).send({ currency: 'EUR' })).status).toBe(400);
  });

  it('the Razorpay order is created in INR with the amount in paise: price x quantity x 100, rounded', async () => {
    const ev = await Event.findOne({ title: 'Priced' });
    const tier = await TicketTier.findOne({ name: 'General' });
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key'; process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ id: 'order_inr_1', entity: 'order', amount: 59997, currency: 'INR', receipt: 'r' }) } as any);
    const res = await request.post('/api/v1/payments/order').set(bearer(org)).send({ eventId: String(ev!._id), ticketTierId: String(tier!._id), quantity: 3 });
    const sent = JSON.parse((spy.mock.calls[0][1] as any).body);
    spy.mockRestore(); delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
    expect(res.status).toBe(201);
    expect(sent.currency).toBe('INR');
    expect(sent.amount).toBe(59997); // 199.99 x 3 = 599.97 rupees = 59997 paise
    expect(res.body.data.order.amount).toBeCloseTo(599.97, 2);
    expect(res.body.data.order.currency).toBe('INR');
    expect(res.body.data.payment.currency).toBe('INR');
  });
});
