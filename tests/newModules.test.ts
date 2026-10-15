import mongoose from 'mongoose';
import supertest from 'supertest';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { generateAccessToken } from '../src/utils/token';

const request = supertest(app);

describe('New Modules (Category, Template, Notification, AuditLog, Report, TicketTier, Payment)', () => {
  jest.setTimeout(60000);

  let mongoServer: MongoMemoryServer;
  let adminToken: string;
  let adminId: string;
  let organizerToken: string;
  let organizerId: string;
  let eventId: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});

    const admin = await User.create({
      fullName: 'Admin User',
      email: 'admin@example.com',
      role: Role.ADMIN,
      passwordHash: 'hash'
    });
    adminId = (admin._id as any).toString();
    adminToken = generateAccessToken(adminId, Role.ADMIN);

    const organizer = await User.create({
      fullName: 'Organizer User',
      email: 'organizer@example.com',
      role: Role.ORGANIZER,
      passwordHash: 'hash'
    });
    organizerId = (organizer._id as any).toString();
    organizerToken = generateAccessToken(organizerId, Role.ORGANIZER);

    const event = await Event.create({
      organizerId: new mongoose.Types.ObjectId(organizerId),
      title: 'Report Test Event',
      description: 'Test Desc',
      categoryId: new mongoose.Types.ObjectId(),
      format: 'PHYSICAL' as any,
      schedule: { start: new Date(), end: new Date() }
    });
    eventId = (event._id as any).toString();
  });

  it('Category API: should create and retrieve categories', async () => {
    const createRes = await request
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Technology',
        description: 'Tech conferences & workshops',
        subcategories: [{ name: 'AI & ML' }, { name: 'Web Dev' }]
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.name).toBe('Technology');

    const getRes = await request.get('/api/v1/categories');
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.length).toBe(1);
    expect(getRes.body.data[0].subcategories.length).toBe(2);
  });

  it('Template API: should create and list templates', async () => {
    const createRes = await request
      .post('/api/v1/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Modern Dark Invitation',
        isSystemTemplate: true,
        templateData: { theme: 'dark', font: 'Inter' }
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.name).toBe('Modern Dark Invitation');

    const getRes = await request
      .get('/api/v1/templates')
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.length).toBe(1);
    expect(getRes.body.meta).toMatchObject({ page: 1, limit: 25, total: 1 });
  });

  it('Template API: organizers cannot create, update, or delete templates', async () => {
    const createRes = await request
      .post('/api/v1/templates')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Should Not Be Created' });
    expect(createRes.status).toBe(403);

    const seeded = await request
      .post('/api/v1/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Seed Template' });
    const templateId = seeded.body.data._id;

    const updateRes = await request
      .patch(`/api/v1/templates/${templateId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Hijacked Name' });
    expect(updateRes.status).toBe(403);

    const deleteRes = await request
      .delete(`/api/v1/templates/${templateId}`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(deleteRes.status).toBe(403);

    const unauthenticatedRes = await request.post('/api/v1/templates').send({ name: 'No Token' });
    expect(unauthenticatedRes.status).toBe(401);
  });

  it('Template API: a persisted name/publish edit survives reload', async () => {
    const created = await request
      .post('/api/v1/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Draft Badge', isPublished: false });
    const templateId = created.body.data._id;

    const updateRes = await request
      .patch(`/api/v1/templates/${templateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Published Badge', isPublished: true });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.name).toBe('Published Badge');
    expect(updateRes.body.data.isPublished).toBe(true);

    const reread = await request
      .get(`/api/v1/templates/${templateId}`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(reread.body.data.name).toBe('Published Badge');
    expect(reread.body.data.isPublished).toBe(true);
  });

  it('Notification API: should list and mark notifications as read', async () => {
    const getRes = await request
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.data)).toBe(true);

    const markAllRes = await request
      .patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(markAllRes.status).toBe(200);
  });

  it('AuditLog API: should retrieve audit logs', async () => {
    const getRes = await request
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.data)).toBe(true);
  });

  it('Report API: should return dashboard and event analytics', async () => {
    const dashRes = await request
      .get('/api/v1/reports/dashboard')
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(dashRes.status).toBe(200);
    expect(dashRes.body.data.totalEvents).toBe(1);

    const eventRepRes = await request
      .get(`/api/v1/reports/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(eventRepRes.status).toBe(200);
    expect(eventRepRes.body.data.event.title).toBe('Report Test Event');
  });

  it('TicketTier & Payment API: should create ticket tier, order tickets and verify payment', async () => {
    // 1. Create Ticket Tier
    const tierRes = await request
      .post(`/api/v1/events/${eventId}/tickets`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'VIP Pass',
        price: 1500,
        capacity: 100
      });

    expect(tierRes.status).toBe(201);
    const tierId = tierRes.body.data._id;

    // 2. Without Razorpay credentials the order must be refused, never faked
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    const unconfiguredRes = await request
      .post('/api/v1/payments/order')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ eventId, ticketTierId: tierId, quantity: 2 });
    expect(unconfiguredRes.status).toBe(503);

    // 3. With credentials, the order is created at the provider (provider call is stubbed here)
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'order_provider_123', entity: 'order', amount: 300000, currency: 'INR', receipt: 'rcpt' })
    } as any);

    const orderRes = await request
      .post('/api/v1/payments/order')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        eventId,
        ticketTierId: tierId,
        quantity: 2
      });
    fetchSpy.mockRestore();

    expect(orderRes.status).toBe(201);
    expect(orderRes.body.data.order.amount).toBe(3000);
    const providerOrderId = orderRes.body.data.payment.providerOrderId;
    expect(providerOrderId).toBe('order_provider_123');

    // 4. Verification without a valid signature must fail
    const unsignedRes = await request
      .post('/api/v1/payments/verify')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ providerOrderId, providerPaymentId: 'pay_rzp_unsigned' });
    expect(unsignedRes.status).toBe(400);

    // 5. Verify Payment with a correct signature & Generate Invoice
    const crypto = await import('crypto');
    const signature = crypto.createHmac('sha256', 'rzp_test_secret').update(`${providerOrderId}|pay_rzp_signed`).digest('hex');
    const verifyRes = await request
      .post('/api/v1/payments/verify')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        providerOrderId,
        providerPaymentId: 'pay_rzp_signed',
        signature
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.order.status).toBe('PAID');
    expect(verifyRes.body.data.invoice.invoiceNumber).toContain('INV-');

    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });
});
