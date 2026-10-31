/**
 * The Add/Edit Event form lets the organizer pin the venue on a map. The pin travels as [longitude, latitude] and must come
 * back as a GeoJSON Point; anything that is not a real coordinate pair is dropped instead of reaching the geo index.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { normalizeLocation } from '../src/services/event.service';
import { generateAccessToken } from '../src/utils/token';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

let mongoServer: MongoMemoryServer;
let token: string;
const storedPin = async (id: string) => (await Event.findById(id).lean())?.location?.coordinates?.coordinates;
const bearer = () => ({ Authorization: `Bearer ${token}` });
const body = (location: unknown) => ({
  title: 'Venue Test', description: 'd', format: 'PHYSICAL', location,
  schedule: { start: '2030-01-01T10:00:00.000Z', end: '2030-01-01T12:00:00.000Z' },
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.JWT_SECRET = 'test_secret';
  await mongoose.connect(mongoServer.getUri());
  const org = await User.create({ fullName: 'Loc Org', email: 'loc-org@example.com', passwordHash: 'x', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  token = generateAccessToken(String(org._id), Role.ORGANIZER);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('normalizeLocation', () => {
  it('turns a [lng, lat] pair into a GeoJSON Point and keeps the address', () => {
    expect(normalizeLocation({ address: 'Park Street', coordinates: [88.36, 22.55] }))
      .toEqual({ address: 'Park Street', coordinates: { type: 'Point', coordinates: [88.36, 22.55] } });
  });
  it('drops values that are not a real coordinate pair', () => {
    for (const bad of [[200, 10], [10, 95], ['a', 'b'], [1], [NaN, 1], 'x', null]) {
      expect(normalizeLocation({ address: 'A', coordinates: bad })).toEqual({ address: 'A' });
    }
  });
});

describe('venue pin through the API', () => {
  it('stores the pin as a GeoJSON Point', async () => {
    const created = await request(app).post('/api/v1/events').set(bearer()).send(body({ address: 'Park Street, Kolkata', coordinates: [88.3639, 22.5726] }));
    expect(created.status).toBe(201);
    const id = created.body.data.eventId;
    expect((await Event.findById(id).lean())?.location).toMatchObject({ address: 'Park Street, Kolkata', coordinates: { type: 'Point', coordinates: [88.3639, 22.5726] } });
  });

  it('creates the event without a pin, and ignores an invalid one', async () => {
    const plain = await request(app).post('/api/v1/events').set(bearer()).send(body({ address: 'Somewhere' }));
    expect(plain.status).toBe(201);
    expect(await storedPin(plain.body.data.eventId)).toBeUndefined();
    const bad = await request(app).post('/api/v1/events').set(bearer()).send(body({ address: 'Nowhere', coordinates: [999, 999] }));
    expect(bad.status).toBe(201);
    expect(await storedPin(bad.body.data.eventId)).toBeUndefined();
  });

  it('editing the address without a pin clears the old pin', async () => {
    const created = await request(app).post('/api/v1/events').set(bearer()).send(body({ address: 'Old', coordinates: [77.2, 28.6] }));
    const id = created.body.data.eventId;
    const updated = await request(app).patch(`/api/v1/events/${id}`).set(bearer()).send({ location: { address: 'New place' } });
    expect(updated.status).toBe(200);
    expect((await Event.findById(id).lean())?.location?.address).toBe('New place');
    expect(await storedPin(id)).toBeUndefined();
  });
});

describe('Event Location (required) and Address (optional) are separate fields', () => {
  let tok: string; let ownerId: any;
  beforeAll(async () => {
    const { User, Role } = await import('../src/models/User');
    const { generateAccessToken } = await import('../src/utils/token');
    const u = await User.create({ fullName: 'Loc Owner', email: 'loc.sep@example.com', role: Role.ORGANIZER });
    ownerId = u._id; tok = generateAccessToken(String(u._id), Role.ORGANIZER);
  });
  const create = (body: object) => request(app).post('/api/v1/events').set('Authorization', `Bearer ${tok}`).send({ title: 'Sep Event', format: 'PHYSICAL', ...body });

  it('refuses a physical event without a venue', async () => {
    expect((await create({})).status).toBe(400);
    expect((await create({ location: { address: '   ' } })).status).toBe(400);
    expect((await create({ location: { addressDetails: 'Gate 3' } })).status).toBe(400);
  });
  it('stores the venue and the optional address separately, and keeps the address through an edit', async () => {
    const res = await create({ location: { address: 'Grand Hall', addressDetails: 'Gate 3, Sector V' } });
    expect(res.status).toBe(201);
    const id = res.body.data.eventId;
    let ev: any = await Event.findById(id).lean();
    expect(ev.location.address).toBe('Grand Hall');
    expect(ev.location.addressDetails).toBe('Gate 3, Sector V');
    const edit = await request(app).patch(`/api/v1/events/${id}`).set('Authorization', `Bearer ${tok}`).send({ location: { address: 'Grand Hall Annex', addressDetails: 'Gate 4' } });
    expect(edit.status).toBe(200);
    ev = await Event.findById(id).lean();
    expect([ev.location.address, ev.location.addressDetails]).toEqual(['Grand Hall Annex', 'Gate 4']);
  });
  it('the address is optional and length-limited; an empty venue on edit is refused', async () => {
    const ok = await create({ location: { address: 'Only Venue' } });
    expect(ok.status).toBe(201);
    expect((await create({ location: { address: 'V', addressDetails: 'x'.repeat(501) } })).status).toBe(400);
    const patch = await request(app).patch(`/api/v1/events/${ok.body.data.eventId}`).set('Authorization', `Bearer ${tok}`).send({ location: { address: '' } });
    expect(patch.status).toBe(400);
  });
});

describe('Event Location length', () => {
  it('rejects a location longer than the invitation card can show, accepts one at the limit', async () => {
    const tooLong = await request(app).post('/api/v1/events').set(bearer()).send(body({ address: 'x'.repeat(51) }));
    expect(tooLong.status).toBe(400);
    const atLimit = await request(app).post('/api/v1/events').set(bearer()).send(body({ address: 'x'.repeat(50) }));
    expect(atLimit.status).toBe(201);
  });
});
