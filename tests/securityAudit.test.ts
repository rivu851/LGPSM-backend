import crypto from 'crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Session } from '../src/models/Session';
import { Invitee } from '../src/models/Invitee';
import { TicketTier } from '../src/models/TicketTier';
import { Order, OrderStatus } from '../src/models/Order';
import { Payment, PaymentStatus } from '../src/models/Payment';
import { RefreshToken } from '../src/models/RefreshToken';
import { generateAccessToken, generatePasswordResetToken } from '../src/utils/token';
import * as xlsx from 'xlsx';
import { inviteeService, MAX_IMPORT_ROWS } from '../src/services/invitee.service';
import { sanitizeDetail } from '../src/utils/securityLog';
import { fetchPublicImage, isPrivateAddress } from '../src/utils/safeFetch';
import { resolveImageKeyBase64 } from '../src/utils/resolveImageBase64';

// Security audit regression suite. Every test here encodes an attack that was proven against the
// code before it was fixed (or a control that must keep holding). No real mail or network is used.
jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const bearer = (user: any) => `Bearer ${generateAccessToken(String(user._id), user.role)}`;
const oid = () => new mongoose.Types.ObjectId().toString();

async function makeUser(role: Role, email: string, extra: Record<string, unknown> = {}) {
  return User.create({ fullName: `${role} ${email}`, email, role, isActive: true, isEmailVerified: true, ...extra });
}

describe('Cross-tenant authorization matrix (organizer B must not touch organizer A data)', () => {
  let orgA: any, orgB: any, staff: any, admin: any;
  let eventA: any, sessionA: any, inviteeA: any, tierA: any;

  beforeAll(async () => {
    admin = await makeUser(Role.ADMIN, 'matrix.admin@example.com');
    orgA = await makeUser(Role.ORGANIZER, 'matrix.a@example.com');
    orgB = await makeUser(Role.ORGANIZER, 'matrix.b@example.com');
    staff = await makeUser(Role.SYSTEM_USER, 'matrix.staff@example.com', { createdBy: orgB._id });

    const created = await request(app).post('/api/v1/events').set('Authorization', bearer(orgA)).send({ title: 'A private event' });
    expect(created.status).toBe(201);
    eventA = await Event.findById(created.body.data.eventId);

    const now = Date.now();
    sessionA = await Session.create({
      eventId: eventA._id,
      name: 'A session',
      schedule: { start: new Date(now + 3600_000), end: new Date(now + 7200_000) }
    });
    inviteeA = await Invitee.create({ eventId: eventA._id, name: 'A guest', email: 'guest.a@example.com' });
    tierA = await TicketTier.create({ eventId: eventA._id, name: 'General', price: 100, capacity: 10 });
  });

  const E = () => `/api/v1/events/${eventA._id}`;

  it.each([
    ['read the event', () => request(app).get(E())],
    ['update the event', () => request(app).patch(E()).send({ title: 'hijacked' })],
    ['delete the event', () => request(app).delete(E())],
    ['list its sessions', () => request(app).get(`${E()}/sessions`)],
    ['create a session', () => request(app).post(`${E()}/sessions`).send({ name: 'x', schedule: { start: new Date(Date.now() + 1e6).toISOString(), end: new Date(Date.now() + 2e6).toISOString() } })],
    ['read a session', () => request(app).get(`/api/v1/sessions/${sessionA._id}`)],
    ['update a session', () => request(app).patch(`/api/v1/sessions/${sessionA._id}`).send({ name: 'hijacked' })],
    ['delete a session', () => request(app).delete(`/api/v1/sessions/${sessionA._id}`)],
    ['list invitees', () => request(app).get(`${E()}/invitees`)],
    ['create an invitee', () => request(app).post(`${E()}/invitees`).send({ name: 'Intruder', email: 'intruder@example.com' })],
    ['read an invitee', () => request(app).get(`/api/v1/invitees/${inviteeA._id}`)],
    ['update an invitee', () => request(app).patch(`/api/v1/invitees/${inviteeA._id}`).send({ name: 'hijacked' })],
    ['delete an invitee', () => request(app).delete(`/api/v1/invitees/${inviteeA._id}`)],
    ['list invitations', () => request(app).get(`${E()}/invitations`)],
    ['preview the invitation card', () => request(app).get(`${E()}/invitations/preview`)],
    ['send invitations', () => request(app).post(`${E()}/invitations/send`).send({ channels: ['EMAIL'] })],
    ['list assignments', () => request(app).get(`${E()}/assignments`)],
    ['assign staff', () => request(app).post(`${E()}/assignments`).send({ userId: String(staff._id), sessionIds: [] })],
    ['list check-ins', () => request(app).get(`${E()}/checkins`)],
    ['read the event report', () => request(app).get(`/api/v1/reports/events/${eventA._id}`)],
    ['add a ticket tier', () => request(app).post(`${E()}/tickets`).send({ name: 'VIP', price: 1, capacity: 1 })],
    ['edit a ticket tier', () => request(app).patch(`/api/v1/tickets/${tierA._id}`).send({ price: 0 })],
    ['delete a ticket tier', () => request(app).delete(`/api/v1/tickets/${tierA._id}`)]
  ])('organizer B cannot %s', async (_label, call) => {
    const res = await (call() as any).set('Authorization', bearer(orgB));
    expect([400, 403, 404]).toContain(res.status);
    expect(res.status).not.toBeLessThan(400);
  });

  it('left organizer A data untouched by every attempt above', async () => {
    const event = await Event.findById(eventA._id);
    expect(event?.title).toBe('A private event');
    expect(event?.status).toBe('PUBLISHED');
    expect(await Session.countDocuments({ eventId: eventA._id })).toBe(1);
    expect((await Session.findById(sessionA._id))?.name).toBe('A session');
    expect(await Invitee.countDocuments({ eventId: eventA._id })).toBe(1);
    expect((await Invitee.findById(inviteeA._id))?.name).toBe('A guest');
    expect((await TicketTier.findById(tierA._id))?.price).toBe(100);
  });

  it('does not list organizer A events to organizer B', async () => {
    const res = await request(app).get('/api/v1/events').set('Authorization', bearer(orgB));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(String(eventA._id));
  });

  it('lists organizer A events with their own invitee and session totals', async () => {
    const res = await request(app).get('/api/v1/events').set('Authorization', bearer(orgA));
    expect(res.status).toBe(200);
    const listed = res.body.data.find((e: any) => String(e._id) === String(eventA._id));
    expect(listed).toMatchObject({ inviteesCount: await Invitee.countDocuments({ eventId: eventA._id }), sessionNames: ['A session'] });
  });

  it('staff with no assignment cannot read the event, its sessions or its invitees', async () => {
    for (const path of [E(), `${E()}/sessions`, `${E()}/invitees`]) {
      const res = await request(app).get(path).set('Authorization', bearer(staff));
      expect([403, 404]).toContain(res.status);
    }
  });

  it('rejects unauthenticated access to protected routes', async () => {
    for (const path of [E(), `${E()}/invitees`, `/api/v1/reports/dashboard`, '/api/users/profile', '/api/v1/notifications']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  it('rejects a tampered, wrong-secret or alg=none token', async () => {
    const good = generateAccessToken(String(orgA._id), Role.ORGANIZER);
    const [h, p, s] = good.split('.');
    const promoted = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'ADMIN' })).toString('base64url');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    for (const token of [`${h}.${promoted}.${s}`, none, `${h}.${p}.${s.slice(0, -2)}xx`]) {
      const res = await request(app).get('/api/users/profile').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
  });

  it('does not let a deactivated user keep using a still-valid token', async () => {
    const temp = await makeUser(Role.ORGANIZER, 'matrix.inactive@example.com');
    const header = bearer(temp);
    expect((await request(app).get('/api/users/profile').set('Authorization', header)).status).toBe(200);
    await User.updateOne({ _id: temp._id }, { isActive: false });
    expect((await request(app).get('/api/users/profile').set('Authorization', header)).status).toBe(403);
  });
});

describe('SEC-001: organizers cannot create events under another account or set server-controlled fields', () => {
  it('forces organizerId to the caller and ignores privileged fields', async () => {
    const attacker = await makeUser(Role.ORGANIZER, 'sec001.attacker@example.com');
    const victim = await makeUser(Role.ORGANIZER, 'sec001.victim@example.com');

    const res = await request(app)
      .post('/api/v1/events')
      .set('Authorization', bearer(attacker))
      .send({ title: 'Planted event', organizerId: String(victim._id), organizerIds: [String(victim._id)], operationalDataCleared: true, status: 'COMPLETED' });

    expect(res.status).toBe(201);
    const stored = await Event.findById(res.body.data.eventId);
    expect(String(stored?.organizerId)).toBe(String(attacker._id));
    expect(stored?.operationalDataCleared).toBeFalsy();
    expect(stored?.status).toBe('PUBLISHED');
    expect(await Event.countDocuments({ organizerId: victim._id })).toBe(0);
  });

  it('still lets an admin create an event on behalf of a chosen organizer', async () => {
    const admin = await makeUser(Role.ADMIN, 'sec001.admin@example.com');
    const organizer = await makeUser(Role.ORGANIZER, 'sec001.target@example.com');
    const res = await request(app).post('/api/v1/events').set('Authorization', bearer(admin)).send({ title: 'Admin-created', organizerId: String(organizer._id) });
    expect(res.status).toBe(201);
    expect(String((await Event.findById(res.body.data.eventId))?.organizerId)).toBe(String(organizer._id));
  });

  it('does not let an organizer update server-controlled event fields', async () => {
    const owner = await makeUser(Role.ORGANIZER, 'sec001.owner@example.com');
    const other = await makeUser(Role.ORGANIZER, 'sec001.other@example.com');
    const created = await request(app).post('/api/v1/events').set('Authorization', bearer(owner)).send({ title: 'Mine' });
    const id = created.body.data.eventId;
    await request(app)
      .patch(`/api/v1/events/${id}`)
      .set('Authorization', bearer(owner))
      .send({ title: 'Renamed', organizerId: String(other._id), operationalDataCleared: true, pricing: { ratePerInvitee: 0 } });
    const stored = await Event.findById(id);
    expect(stored?.title).toBe('Renamed');
    expect(String(stored?.organizerId)).toBe(String(owner._id));
    expect(stored?.operationalDataCleared).toBeFalsy();
  });
});

describe('SEC-005: privileges come from the database, not the token claim', () => {
  it('stops honoring ADMIN rights once the user is demoted', async () => {
    const user = await makeUser(Role.ADMIN, 'sec005.admin@example.com');
    const header = bearer(user);
    expect((await request(app).get('/api/v1/settings/pricing').set('Authorization', header)).status).toBe(200);
    await User.updateOne({ _id: user._id }, { role: Role.ORGANIZER });
    expect((await request(app).get('/api/v1/settings/pricing').set('Authorization', header)).status).toBe(403);
  });
});

describe('SEC-006: password reset tokens are single use and sessions end on password change', () => {
  async function registerAndLogin(email: string) {
    await request(app).post('/api/auth/register').send({ fullName: 'Reset User', email, password: 'Password123!' });
    await User.updateOne({ email }, { isEmailVerified: true });
    return request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
  }

  it('rejects a reset link that was already used', async () => {
    await registerAndLogin('sec006.reset@example.com');
    const user: any = await User.findOne({ email: 'sec006.reset@example.com' });
    const token = generatePasswordResetToken(String(user._id), user.role, user.passwordHash);

    const first = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'FirstNewPass1!' });
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'AttackerPass1!' });
    expect(second.status).toBe(400);

    const login = await request(app).post('/api/auth/login').send({ email: 'sec006.reset@example.com', password: 'FirstNewPass1!' });
    expect(login.status).toBe(200);
  });

  it('revokes every refresh token when the password is changed', async () => {
    const login = await registerAndLogin('sec006.change@example.com');
    const { accessToken, refreshToken } = login.body.data;
    const change = await request(app)
      .patch('/api/users/me/password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'Password123!', newPassword: 'BrandNewPass1!' });
    expect(change.status).toBe(200);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken })).status).toBe(401);
    expect(await RefreshToken.countDocuments({ isRevoked: false, userId: (await User.findOne({ email: 'sec006.change@example.com' }))!._id })).toBe(0);
  });
});

describe('SEC-007: payments are idempotent and a paid payment cannot be downgraded', () => {
  const SECRET = 'audit-test-razorpay-secret';
  const sign = (orderId: string, paymentId: string) => crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  let buyer: any, tier: any, providerOrderId: string;

  beforeAll(() => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_audit';
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = 'audit-webhook-secret';
  });

  beforeEach(async () => {
    buyer = await makeUser(Role.ORGANIZER, `sec007.${crypto.randomBytes(4).toString('hex')}@example.com`);
    const organizer = await makeUser(Role.ORGANIZER, `sec007.org.${crypto.randomBytes(4).toString('hex')}@example.com`);
    const event = await Event.create({ title: 'Ticketed', description: 'd', format: 'PHYSICAL', organizerId: organizer._id, categoryId: oid(), schedule: { start: new Date(), end: new Date(Date.now() + 1e6) } });
    tier = await TicketTier.create({ eventId: event._id, name: 'GA', price: 10, capacity: 100 });
    providerOrderId = `order_${crypto.randomBytes(6).toString('hex')}`;
    const order = await Order.create({ userId: buyer._id, eventId: event._id, ticketTierId: tier._id, quantity: 2, amount: 20, currency: 'INR', providerOrderId, status: OrderStatus.PENDING });
    await Payment.create({ orderId: order._id, userId: buyer._id, eventId: event._id, provider: 'RAZORPAY', providerOrderId, amountBase: 20, taxAmount: 0, totalAmount: 20, currency: 'INR', status: PaymentStatus.CREATED, signatureVerified: false });
  });

  const verify = (paymentId: string, signature?: string) =>
    request(app).post('/api/v1/payments/verify').set('Authorization', bearer(buyer)).send({ providerOrderId, providerPaymentId: paymentId, signature });

  it('counts a verified payment once, however many times verify is replayed', async () => {
    const sig = sign(providerOrderId, 'pay_1');
    expect((await verify('pay_1', sig)).status).toBe(200);
    expect((await verify('pay_1', sig)).status).toBe(200);
    expect((await verify('pay_1', sig)).status).toBe(200);
    expect((await TicketTier.findById(tier._id))?.sold).toBe(2);
  });

  it('does not downgrade a PAID payment when a bad signature is submitted later', async () => {
    expect((await verify('pay_2', sign(providerOrderId, 'pay_2'))).status).toBe(200);
    expect((await verify('pay_2', 'deadbeef')).status).toBe(400);
    expect((await Payment.findOne({ providerOrderId }))?.status).toBe(PaymentStatus.PAID);
    expect((await Order.findOne({ providerOrderId }))?.status).toBe(OrderStatus.PAID);
    expect((await TicketTier.findById(tier._id))?.sold).toBe(2);
  });

  it('does not double count when the webhook and the browser verify both confirm', async () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_3', order_id: providerOrderId } } } });
    const signature = crypto.createHmac('sha256', 'audit-webhook-secret').update(body).digest('hex');
    const hook = () => request(app).post('/api/v1/payments/webhook').set('content-type', 'application/json').set('x-razorpay-signature', signature).send(body);
    await Promise.all([hook(), verify('pay_3', sign(providerOrderId, 'pay_3'))]);
    await hook();
    expect((await TicketTier.findById(tier._id))?.sold).toBe(2);
  });

  it('verifies the webhook signature over the raw bytes that were sent', async () => {
    // Same JSON, but with whitespace JSON.stringify would not reproduce
    const raw = '{ "event": "payment.captured",  "payload": { "payment": { "entity": { "id": "pay_4", "order_id": "' + providerOrderId + '" } } } }';
    const signature = crypto.createHmac('sha256', 'audit-webhook-secret').update(raw).digest('hex');
    const res = await request(app).post('/api/v1/payments/webhook').set('content-type', 'application/json').set('x-razorpay-signature', signature).send(raw);
    expect(res.status).toBe(200);
    expect((await Payment.findOne({ providerOrderId }))?.status).toBe(PaymentStatus.PAID);
  });

  it('rejects a webhook whose signature does not match', async () => {
    const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_5', order_id: providerOrderId } } } });
    const res = await request(app).post('/api/v1/payments/webhook').set('content-type', 'application/json').set('x-razorpay-signature', 'a'.repeat(64)).send(raw);
    expect(res.status).toBe(400);
    expect((await Payment.findOne({ providerOrderId }))?.status).toBe(PaymentStatus.CREATED);
  });

  it("does not let another user verify or read someone else's payment", async () => {
    const stranger = await makeUser(Role.ORGANIZER, `sec007.stranger.${crypto.randomBytes(4).toString('hex')}@example.com`);
    const res = await request(app).post('/api/v1/payments/verify').set('Authorization', bearer(stranger)).send({ providerOrderId, providerPaymentId: 'pay_x', signature: sign(providerOrderId, 'pay_x') });
    expect(res.status).toBe(404);
    expect((await Payment.findOne({ providerOrderId }))?.status).toBe(PaymentStatus.CREATED);
  });
});

describe('SEC-008: no internal error text is returned to clients', () => {
  it('returns a generic message from the payments controller on unexpected failures', async () => {
    const user = await makeUser(Role.ORGANIZER, 'sec008.user@example.com');
    const spy = jest.spyOn(Order, 'find').mockImplementation((() => { throw new Error('E11000 internal-detail mongodb://secret-host'); }) as any);
    const res = await request(app).get('/api/v1/orders').set('Authorization', bearer(user));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/E11000|mongodb:|secret-host|internal-detail/);
  });
});

describe('SEC-002: user-supplied image URLs cannot reach internal networks (SSRF)', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254'
  ])('treats %s as an internal address', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])('allows public address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each([
    ['plain http', 'http://example.com/a.png'],
    ['loopback literal', 'https://127.0.0.1/a.png'],
    ['cloud metadata address', 'https://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'https://[::1]/a.png'],
    ['hostname resolving to loopback', 'https://localhost/a.png'],
    ['embedded credentials', 'https://user:pass@example.com/a.png'],
    ['non-default port', 'https://example.com:8443/a.png'],
    ['file scheme', 'file:///etc/passwd'],
    ['not a URL', 'nonsense']
  ])('refuses %s', async (_label, url) => {
    await expect(fetchPublicImage(url)).rejects.toThrow();
  });

  it('turns a refused URL into "no image" instead of failing the card render', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await resolveImageKeyBase64('https://169.254.169.254/latest/meta-data/')).toBe('');
    expect(await resolveImageKeyBase64('https://localhost/secret.png')).toBe('');
    warn.mockRestore();
  });
});

describe('SEC-010: spreadsheet imports are bounded', () => {
  const sheet = (rows: unknown[][]) => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'Invitees');
    return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  };

  it('rejects a sheet with more rows than the limit before processing it', async () => {
    const owner = await makeUser(Role.ORGANIZER, 'sec010.owner@example.com');
    const event = await Event.create({ title: 'Import', description: 'd', format: 'PHYSICAL', organizerId: owner._id, categoryId: oid(), schedule: { start: new Date(), end: new Date(Date.now() + 1e6) } });
    const rows: unknown[][] = [['Name', 'Email', 'Mobile']];
    for (let i = 0; i < MAX_IMPORT_ROWS + 50; i++) rows.push([`Guest ${i}`, `guest${i}@example.com`, '']);

    await expect(inviteeService.processExcelImport(String(event._id), String(owner._id), sheet(rows), { role: Role.ORGANIZER })).rejects.toMatchObject({ statusCode: 400 });
    expect(await Invitee.countDocuments({ eventId: event._id })).toBe(0);
  });

  it('rejects an unreadable file with a client error rather than crashing', async () => {
    const owner = await makeUser(Role.ORGANIZER, 'sec010.garbage@example.com');
    const event = await Event.create({ title: 'Import2', description: 'd', format: 'PHYSICAL', organizerId: owner._id, categoryId: oid(), schedule: { start: new Date(), end: new Date(Date.now() + 1e6) } });
    await expect(inviteeService.processExcelImport(String(event._id), String(owner._id), Buffer.from('PK\u0003\u0004not-really-a-zip'), { role: Role.ORGANIZER })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('Security event logging never records credentials', () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    process.env.SECURITY_LOG_IN_TEST = 'true';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.SECURITY_LOG_IN_TEST;
    logSpy.mockRestore();
  });
  const events = () => logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"channel":"security"'));

  it('drops sensitive keys and truncates/flattens values', () => {
    const clean = sanitizeDetail({ password: 'hunter2', otp: '123456', accessToken: 'abc', apiKey: 'k', reason: 'x'.repeat(500) + '\ninjected', ok: true, count: 3, nested: { a: 1 } });
    expect(Object.keys(clean).sort()).toEqual(['count', 'ok', 'reason']);
    expect(String(clean.reason).length).toBeLessThanOrEqual(120);
    expect(String(clean.reason)).not.toMatch(/\n/);
  });

  it('logs a failed sign-in without the password or the identifier', async () => {
    await request(app).post('/api/auth/login').send({ email: 'nobody.logged@example.com', password: 'S3cretPassw0rd!' });
    const lines = events();
    expect(lines.some((l) => l.includes('"event":"LOGIN_FAILED"'))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain('S3cretPassw0rd!');
      expect(l).not.toContain('nobody.logged@example.com');
    }
  });

  it('logs rejected tokens and authorization denials with the route but not the token or query string', async () => {
    const organizer = await makeUser(Role.ORGANIZER, 'seclog.org@example.com');
    const token = generateAccessToken(String(organizer._id), organizer.role);
    await request(app).get('/api/v1/settings/pricing?secret=abc123').set('Authorization', `Bearer ${token}`);
    await request(app).get('/api/users/profile').set('Authorization', 'Bearer not.a.token');
    const lines = events();
    expect(lines.some((l) => l.includes('"event":"AUTHZ_DENIED"') && l.includes('/api/v1/settings/pricing'))).toBe(true);
    expect(lines.some((l) => l.includes('"event":"AUTH_TOKEN_REJECTED"'))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain(token);
      expect(l).not.toContain('abc123');
    }
  });
});

describe('SEC-019: mail credentials are never written to the logs', () => {
  it('does not print the SMTP password (or user) when sending an email', async () => {
    jest.resetModules();
    jest.doMock('nodemailer', () => ({ createTransport: () => ({ sendMail: jest.fn().mockResolvedValue({}) }) }));
    const saved = { ...process.env };
    process.env.SMTP_HOST = 'smtp.audit.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'audit-user@example.com';
    process.env.SMTP_PASS = 'S3cr3t-Smtp-Passw0rd-audit';
    const out: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(' ')); }));
    try {
      // the real provider, not the mock the rest of this file installs
      const { sendEmail: realSend } = jest.requireActual('../src/utils/email.provider');
      await realSend('guest@example.com', 'Hello', '<p>hi</p>');
    } finally {
      spies.forEach((s) => s.mockRestore());
      process.env = saved;
      jest.dontMock('nodemailer');
    }
    const logged = out.join('\n');
    expect(logged).not.toContain('S3cr3t-Smtp-Passw0rd-audit');
    expect(logged).not.toContain('audit-user@example.com');
  });
});
