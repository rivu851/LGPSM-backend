/**
 * An admin's uploaded design can hold fewer title characters than the usual 50 (templateData.titleMaxChars). The Add Event form applies that
 * number and the server checks the same number, so the two always agree.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Template } from '../src/models/Template';
import { generateAccessToken } from '../src/utils/token';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

let mongoServer: MongoMemoryServer;
let token: string;
let templateId: string;
const bearer = () => ({ Authorization: `Bearer ${token}` });
const body = (title: string, extra: object = {}) => ({
  title, description: 'd', format: 'PHYSICAL', location: { address: 'Hall' },
  schedule: { start: '2030-01-01T10:00:00.000Z', end: '2030-01-01T12:00:00.000Z' }, ...extra,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.JWT_SECRET = 'test_secret';
  await mongoose.connect(mongoServer.getUri());
  const org = await User.create({ fullName: 'Limit Org', email: 'limit-org@example.com', passwordHash: 'x', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  token = generateAccessToken(String(org._id), Role.ORGANIZER);
  const t = await Template.create({ name: 'Short title area', cardDesign: 'BIRTHDAY', kind: 'INVITATION', isSystemTemplate: true, isPublished: true, isActive: true, templateData: { titleMaxChars: 20 } });
  templateId = String(t._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('title limit set by a template', () => {
  it('rejects a title longer than the template can hold, and accepts one that fits', async () => {
    const tooLong = await request(app).post('/api/v1/events').set(bearer()).send(body('A title that is far too long for it', { templateId }));
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(tooLong.body)).toMatch(/cannot exceed 20 characters on this template/);
    const fits = await request(app).post('/api/v1/events').set(bearer()).send(body('Short title', { templateId }));
    expect(fits.status).toBe(201);
  });

  it('changing the title or the template of an event is checked the same way', async () => {
    const plain = await request(app).post('/api/v1/events').set(bearer()).send(body('A title that is far too long for it'));
    expect(plain.status).toBe(201);
    const id = plain.body.data.eventId;
    const switched = await request(app).patch(`/api/v1/events/${id}`).set(bearer()).send({ templateId });
    expect(switched.status).toBe(400);
    const retitled = await request(app).patch(`/api/v1/events/${id}`).set(bearer()).send({ title: 'Short title' });
    expect(retitled.status).toBe(200);
  });
});
