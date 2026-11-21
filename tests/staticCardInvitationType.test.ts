/**
 * An uploaded card (a static design) can only be sent: print-ready cards are drawn from a live template. So it is allowed only when the
 * invitation type is Digital only; Print only and Print and Digital both need a ready template.
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
let staticId: string;
let dynamicId: string;
let uploadedWithDetailsId: string;
const bearer = () => ({ Authorization: `Bearer ${token}` });
const body = (extra: object = {}) => ({
  title: 'Type test', description: 'd', format: 'PHYSICAL', location: { address: 'Hall' },
  schedule: { start: '2030-01-01T10:00:00.000Z', end: '2030-01-01T12:00:00.000Z' }, ...extra,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.JWT_SECRET = 'test_secret';
  await mongoose.connect(mongoServer.getUri());
  const org = await User.create({ fullName: 'Type Org', email: 'type-org@example.com', passwordHash: 'x', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  token = generateAccessToken(String(org._id), Role.ORGANIZER);
  const mk = (name: string, templateData: object) => Template.create({ name, cardDesign: 'CUSTOM', kind: 'INVITATION', ownerId: org._id, isSystemTemplate: false, isPublished: true, isActive: true, templateData });
  staticId = String((await mk('Own static card', { uploaded: true }))._id);
  uploadedWithDetailsId = String((await mk('Uploaded, live details', { uploaded: true, dynamicDetails: true }))._id);
  dynamicId = String((await Template.create({ name: 'Ready template', cardDesign: 'BIRTHDAY', kind: 'INVITATION', isSystemTemplate: true, isPublished: true, isActive: true, templateData: {} }))._id);
});
afterAll(async () => { await mongoose.disconnect(); await mongoServer.stop(); });

describe('uploaded card and invitation type', () => {
  it('Digital only may use an uploaded card; Print only and Both may not', async () => {
    const digital = await request(app).post('/api/v1/events').set(bearer()).send(body({ templateId: staticId, invitationType: 'DIGITAL' }));
    expect(digital.status).toBe(201);
    for (const type of ['PRINT', 'BOTH']) {
      const res = await request(app).post('/api/v1/events').set(bearer()).send(body({ templateId: staticId, invitationType: type }));
      expect(res.status).toBe(400);
      expect(res.body.code ?? res.body.error?.code ?? JSON.stringify(res.body)).toMatch(/STATIC_CARD_NOT_ALLOWED|Digital only/);
    }
  });

  it('a ready template, or an uploaded design that keeps live details, works with every type', async () => {
    for (const type of ['DIGITAL', 'PRINT', 'BOTH']) {
      expect((await request(app).post('/api/v1/events').set(bearer()).send(body({ templateId: dynamicId, invitationType: type }))).status).toBe(201);
      expect((await request(app).post('/api/v1/events').set(bearer()).send(body({ templateId: uploadedWithDetailsId, invitationType: type }))).status).toBe(201);
    }
  });

  it('changing an event to Print only, or to an uploaded card, is checked the same way', async () => {
    const made = await request(app).post('/api/v1/events').set(bearer()).send(body({ templateId: staticId, invitationType: 'DIGITAL' }));
    const id = made.body.data.eventId;
    expect((await request(app).patch(`/api/v1/events/${id}`).set(bearer()).send({ invitationType: 'PRINT' })).status).toBe(400);
    expect((await request(app).patch(`/api/v1/events/${id}`).set(bearer()).send({ invitationType: 'BOTH' })).status).toBe(400);
    // switching the card at the same time makes it fine
    expect((await request(app).patch(`/api/v1/events/${id}`).set(bearer()).send({ invitationType: 'PRINT', templateId: dynamicId })).status).toBe(200);
    // and an uploaded card cannot be put on it afterwards
    expect((await request(app).patch(`/api/v1/events/${id}`).set(bearer()).send({ templateId: staticId })).status).toBe(400);
  });
});
