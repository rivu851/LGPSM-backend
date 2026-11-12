import mongoose from 'mongoose';
import supertest from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { IdempotencyKey } from '../src/models/IdempotencyKey';
import { generateAccessToken } from '../src/utils/token';

// Audit finding F-05: (A) a repeated create request made a second event; (B) two editors saving the same event overwrote each other silently.
const request = supertest(app);
jest.setTimeout(120_000);

describe('F-05 A: Idempotency-Key on event creation', () => {
  let mongo: MongoMemoryServer; let orgA: any, orgB: any, admin: any;
  const bearer = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
  const body = (title = 'Idem Event', extra: any = {}) => ({ title, location: { address: 'Hall 1' }, schedule: { start: new Date(Date.now() + 3600e3).toISOString(), end: new Date(Date.now() + 7200e3).toISOString() }, ...extra });
  const create = (u: any, key: string | null, b: any = body()) => { let r = request.post('/api/v1/events').set(bearer(u)); if (key) r = r.set('Idempotency-Key', key); return r.send(b); };
  const countByTitle = (t: string) => Event.countDocuments({ title: t });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([IdempotencyKey.syncIndexes(), Event.syncIndexes()]);
    const mk = (n: string, role: Role) => User.create({ fullName: n, email: `${n.replace(/\W/g, '').toLowerCase()}@i.test`, role, passwordHash: 'x', isActive: true });
    orgA = await mk('Org A', Role.ORGANIZER); orgB = await mk('Org B', Role.ORGANIZER); admin = await mk('Admin One', Role.ADMIN);
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('without a key nothing changes (two identical requests make two events, as before)', async () => {
    await create(orgA, null, body('No Key')); await create(orgA, null, body('No Key'));
    expect(await countByTitle('No Key')).toBe(2);
  });
  it('the same key twice: one event, and the repeat returns the first answer', async () => {
    const same = body('Seq Event'); // a retry sends the very same request
    const a = await create(orgA, 'key-seq-0001', same); const b = await create(orgA, 'key-seq-0001', same);
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    expect(b.body.data.eventId).toBe(a.body.data.eventId);
    expect(b.headers['idempotent-replay']).toBe('true'); expect(a.headers['idempotent-replay']).toBeUndefined();
    expect(await countByTitle('Seq Event')).toBe(1);
  });
  it('12 simultaneous requests with one key: one event, nobody gets a server error', async () => {
    const same = body('Race Event');
    const rs = await Promise.all(Array.from({ length: 12 }, () => create(orgA, 'key-race-0001', same)));
    expect(await countByTitle('Race Event')).toBe(1);
    expect(rs.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(rs.filter((r) => r.status === 201 && !r.headers['idempotent-replay'])).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'REQUEST_IN_PROGRESS')).toBe(true);
    // once the first has finished a retry gets the stored answer
    const again = await create(orgA, 'key-race-0001', same);
    expect(again.status).toBe(201);
    expect(await countByTitle('Race Event')).toBe(1);
  });
  it('different keys make different events', async () => {
    await create(orgA, 'key-diff-0001', body('Diff Event')); await create(orgA, 'key-diff-0002', body('Diff Event'));
    expect(await countByTitle('Diff Event')).toBe(2);
  });
  it('the key belongs to its user: another organizer using the same key gets their own event', async () => {
    const a = await create(orgA, 'key-shared-01', body('Shared Key A')); const b = await create(orgB, 'key-shared-01', body('Shared Key B'));
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    expect(b.body.data.eventId).not.toBe(a.body.data.eventId);
    expect((await Event.findById(b.body.data.eventId))?.organizerId.toString()).toBe(String(orgB._id));
  });
  it('the same key with a different request is refused, and creates nothing', async () => {
    await create(orgA, 'key-reuse-001', body('Reuse One'));
    const res = await create(orgA, 'key-reuse-001', body('Reuse Two'));
    expect(res.status).toBe(422); expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await countByTitle('Reuse Two')).toBe(0);
  });
  it('a request that failed leaves no trace: the same key can be used again with a corrected request', async () => {
    const bad = await create(orgA, 'key-retry-001', body('Retry Event', { categoryId: String(new mongoose.Types.ObjectId()) }));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(await IdempotencyKey.countDocuments({ key: 'key-retry-001' })).toBe(0);
    const good = await create(orgA, 'key-retry-001', body('Retry Event'));
    expect(good.status).toBe(201);
    expect(await countByTitle('Retry Event')).toBe(1);
  });
  it('a malformed key is a 400', async () => {
    expect((await create(orgA, 'short')).status).toBe(400);
    expect((await create(orgA, 'bad key with spaces!')).status).toBe(400);
  });
  it('an invalid body is still rejected by validation and does not use up the key', async () => {
    const res = await create(orgA, 'key-valid-0001', { title: '' });
    expect(res.status).toBe(400);
    expect(await IdempotencyKey.countDocuments({ key: 'key-valid-0001' })).toBe(0);
  });
  it('an admin creating the same event for several organizers does it once per key', async () => {
    const b = body('Multi Org', { organizerIds: [String(orgA._id), String(orgB._id)] });
    const rs = await Promise.all([create(admin, 'key-admin-0001', b), create(admin, 'key-admin-0001', b)]);
    await create(admin, 'key-admin-0001', b);
    expect(await countByTitle('Multi Org')).toBe(2);
    expect(rs.some((r) => r.status === 201)).toBe(true);
  });
  it('browsers may send the two new headers (CORS preflight allows them)', async () => {
    const res = await request.options('/api/v1/events').set('Origin', process.env.FRONTEND_URL || 'http://localhost:3000').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key,if-match');
    expect(res.status).toBeLessThan(300);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toMatch(/idempotency-key/);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toMatch(/if-match/);
  });
});

describe('F-05 B: edits against a stale version are refused, not silently applied', () => {
  let mongo: MongoMemoryServer; let org: any, other: any, admin: any, eventId: string;
  const bearer = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
  const get = async (u = org) => (await request.get(`/api/v1/events/${eventId}`).set(bearer(u))).body.data;
  const patch = (b: any, version?: string, u = org) => { let r = request.patch(`/api/v1/events/${eventId}`).set(bearer(u)); if (version) r = r.set('If-Match', version); return r.send(b); };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    const mk = (n: string, role: Role) => User.create({ fullName: n, email: `${n.replace(/\W/g, '').toLowerCase()}@c.test`, role, passwordHash: 'x', isActive: true });
    org = await mk('Org C', Role.ORGANIZER); other = await mk('Org D', Role.ORGANIZER); admin = await mk('Admin C', Role.ADMIN);
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => {
    const created = await request.post('/api/v1/events').set(bearer(org)).send({ title: 'Edit Me', description: 'first', location: { address: 'Hall' }, contactNumber: '9000000000', schedule: { start: new Date(Date.now() + 3600e3).toISOString(), end: new Date(Date.now() + 7200e3).toISOString() } });
    eventId = created.body.data.eventId;
  });

  it('the event carries the version an editor needs', async () => {
    const ev = await get();
    expect(typeof ev.updatedAt).toBe('string');
    expect(new Date(ev.updatedAt).toISOString()).toBe(ev.updatedAt);
  });
  it('an edit that quotes the current version is applied, and the version moves on', async () => {
    const v1 = (await get()).updatedAt;
    const res = await patch({ title: 'Edit Me v2' }, v1);
    expect(res.status).toBe(200);
    expect(res.body.data.updatedAt).not.toBe(v1);
    expect((await get()).title).toBe('Edit Me v2');
  });
  it('a second tab holding the old version is told the event changed, and its text is NOT applied', async () => {
    const v1 = (await get()).updatedAt;
    expect((await patch({ title: 'First tab' }, v1)).status).toBe(200);
    const stale = await patch({ title: 'Second tab (stale)' }, v1);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('EVENT_EDIT_CONFLICT');
    expect(stale.body.message).toMatch(/changed by someone else/i);
    expect(stale.body.currentVersion).toBeTruthy();
    expect((await get()).title).toBe('First tab');
  });
  it('the stale tab can reload, take the new version and save', async () => {
    const v1 = (await get()).updatedAt;
    await patch({ title: 'First tab' }, v1);
    const v2 = (await get()).updatedAt;
    expect((await patch({ description: 'Second tab, after reloading' }, v2)).status).toBe(200);
    const ev = await get(); expect(ev.title).toBe('First tab'); expect(ev.description).toBe('Second tab, after reloading');
  });
  it('even a stale edit of a DIFFERENT field is refused (the editor has to reload and re-apply)', async () => {
    const v1 = (await get()).updatedAt;
    await patch({ title: 'Tab one' }, v1);
    const res = await patch({ contactNumber: '9111111111' }, v1);
    expect(res.status).toBe(409);
    expect((await get()).contactNumber).toBe('9000000000');
  });
  it('simultaneous saves from the same version: exactly one wins (decided by the database)', async () => {
    const v1 = (await get()).updatedAt;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => patch({ title: `Racer ${i}` }, v1)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    const winner = rs.findIndex((r) => r.status === 200);
    expect((await get()).title).toBe(`Racer ${winner}`);
  });
  it('without If-Match the edit is applied as before (existing clients keep working)', async () => {
    const res = await Promise.all([patch({ title: 'Legacy A' }), patch({ description: 'Legacy B' })]);
    expect(res.every((r) => r.status === 200)).toBe(true);
    const ev = await get(); expect(ev.description).toBe('Legacy B');
  });
  it('a malformed If-Match is a 400 and changes nothing', async () => {
    const res = await patch({ title: 'Nope' }, 'not-a-date');
    expect(res.status).toBe(400); expect(res.body.code).toBe('IF_MATCH_INVALID');
    expect((await get()).title).toBe('Edit Me');
  });
  it('the other rules still apply: another organizer is refused, an admin may edit, a cancelled event is closed', async () => {
    const v = (await get()).updatedAt;
    expect((await patch({ title: 'Hijack' }, v, other)).status).toBe(404);
    expect((await patch({ title: 'Admin edit' }, v, admin)).status).toBe(200);
    await request.post(`/api/v1/events/${eventId}/cancel`).set(bearer(org)).send({});
    expect((await patch({ title: 'Too late' }, (await get()).updatedAt)).status).toBe(409);
  });
});
