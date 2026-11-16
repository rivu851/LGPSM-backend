/**
 * For the testing round the master card is the only template: the only one listed (Templates, template selection, Change template), the
 * one every event is made with, and the card every event gets, whatever template it had before.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Template } from '../src/models/Template';
import { Category } from '../src/models/Category';
import { Event } from '../src/models/Event';
import { generateAccessToken } from '../src/utils/token';
import { loadCardContext } from '../src/services/cardTemplates/context';
import { renderTemplatePreview } from '../src/services/cardTemplates/preview';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.setTimeout(180_000);

const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });

describe('the master card is the only template', () => {
  let mongo: MongoMemoryServer;
  let admin: any, org: any, oldTemplate: any;

  beforeAll(async () => {
    process.env.MASTER_CARD_ONLY = 'true';
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    admin = await User.create({ fullName: 'Admin', email: 'only.admin@x.com', role: Role.ADMIN, isActive: true, isEmailVerified: true });
    org = await User.create({ fullName: 'Org', email: 'only.org@x.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
    oldTemplate = await Template.create({ name: 'Birthday Party', cardDesign: 'BIRTHDAY', isSystemTemplate: true, isPublished: true, isActive: true });
  });
  afterAll(async () => { delete process.env.MASTER_CARD_ONLY; await mongoose.disconnect(); await mongo.stop(); });

  it('lists only the master card (installed the first time it is needed) to an organizer and to an admin', async () => {
    for (const who of [org, admin]) {
      const res = await request(app).get('/api/v1/templates').set(auth(who));
      expect(res.status).toBe(200);
      expect(res.body.data.map((t: any) => t.name)).toEqual(['Master Card']);
    }
    expect(await Template.countDocuments({ cardDesign: 'MASTER' })).toBe(1);
  });

  it('makes every event with the master card, whatever template was asked for', async () => {
    const category = await Category.create({ name: 'Personal', isActive: true });
    const res = await request(app).post('/api/v1/events').set(auth(org)).send({
      title: 'Birthday Bash', description: 'd', format: 'PHYSICAL', categoryId: String(category._id), templateId: String(oldTemplate._id),
      location: { address: 'Hall' }, schedule: { start: '2031-01-01T10:00:00.000Z', end: '2031-01-01T12:00:00.000Z' }
    });
    expect(res.status).toBe(201);
    const event: any = await Event.findById(res.body.data.eventId).lean();
    const master: any = await Template.findOne({ cardDesign: 'MASTER' }).lean();
    expect(String(event.templateId)).toBe(String(master._id));
    expect((await loadCardContext(event)).cardDesign).toBe('MASTER');
  });

  it('draws the master card for an event that still points at an older template, and in the form preview', async () => {
    const category = await Category.create({ name: 'Anything', isActive: true });
    const old: any = await Event.create({ organizerId: org._id, title: 'Old', description: 'd', format: 'PHYSICAL', categoryId: category._id, templateId: oldTemplate._id, schedule: { start: new Date(), end: new Date(Date.now() + 36e5) } });
    expect((await loadCardContext(old)).cardDesign).toBe('MASTER');
    const png = await renderTemplatePreview(String(oldTemplate._id), { title: 'Preview' }, false, String(org._id));
    expect(await sharp(png).metadata()).toMatchObject({ width: 786, height: 1364 });
  });
});
