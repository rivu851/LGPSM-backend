import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { Category } from '../src/models/Category';
import { Template } from '../src/models/Template';
import { Media } from '../src/models/Media';
import { User, Role } from '../src/models/User';
import { generateAccessToken } from '../src/utils/token';
import { DEFAULT_TEMPLATES, planDefaultTemplates, installDefaultTemplates } from '../src/services/cardTemplates/defaultTemplates';

jest.setTimeout(180000);

let mongoServer: MongoMemoryServer;
let admin: any;
let organizer: any;
const bearer = (u: any) => `Bearer ${generateAccessToken(String(u._id), u.role)}`;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  admin = await User.create({ fullName: 'Root', email: 'root.tpl@example.com', role: Role.ADMIN, isActive: true, isEmailVerified: true });
  organizer = await User.create({ fullName: 'Org', email: 'org.tpl@example.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
beforeEach(async () => {
  await Promise.all([Category.deleteMany({}), Template.deleteMany({}), Media.deleteMany({})]);
});

describe('installing the default templates (the master card is the only one for now)', () => {
  it('offers only the master card, tied to no event type', () => {
    expect(DEFAULT_TEMPLATES.map((t) => [t.name, t.cardDesign, t.category])).toEqual([['Master Card', 'MASTER', undefined]]);
  });

  it('plans the master card on an empty database, without writing anything', async () => {
    const plan = await planDefaultTemplates();
    expect(plan.templatesToCreate.map((t) => t.name)).toEqual(['Master Card']);
    expect(plan.categoriesToCreate).toEqual([]);
    expect(await Template.countDocuments()).toBe(0);
    expect(await Category.countDocuments()).toBe(0);
  });

  it('leaves what exists exactly as it was and creates no category', async () => {
    const personal = await Category.create({ name: 'Personal', isActive: true, subcategories: [{ name: 'Birthday' }] });
    const existing = await Template.create({ name: 'Bday Template 1', categoryId: personal._id });
    const before = await Template.findById(existing._id).lean();
    const result = await installDefaultTemplates(String(admin._id));
    expect(result.created).toEqual(['Master Card']);
    expect(await Template.findById(existing._id).lean()).toEqual(before);
    expect(await Category.countDocuments()).toBe(1);
  });

  it('creates a published master card for every event type, with a preview image', async () => {
    await installDefaultTemplates(String(admin._id));
    const templates = await Template.find({}).lean();
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ name: 'Master Card', cardDesign: 'MASTER', isPublished: true, isActive: true, isSystemTemplate: true });
    expect(templates[0].categoryId).toBeUndefined();
    expect(templates[0].previewImageKey).toMatch(/^media:[0-9a-f]{24}$/);
    const media = await Media.findById(templates[0].previewImageKey!.slice(6)).select('+data');
    expect(media!.contentType).toBe('image/jpeg');
    const meta = await sharp(media!.data).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBeGreaterThan(300);
  });

  it('is safe to run again: nothing is created twice', async () => {
    await installDefaultTemplates(String(admin._id));
    const second = await installDefaultTemplates(String(admin._id));
    expect(second.created).toEqual([]);
    expect(await Template.countDocuments()).toBe(1);
    expect(await Media.countDocuments()).toBe(1);
    expect((await planDefaultTemplates()).templatesToCreate).toEqual([]);
  });
});

describe('default templates API', () => {
  it('is for admins only', async () => {
    expect((await request(app).get('/api/v1/templates/defaults')).status).toBe(401);
    expect((await request(app).get('/api/v1/templates/defaults').set('Authorization', bearer(organizer))).status).toBe(403);
    expect((await request(app).post('/api/v1/templates/defaults').set('Authorization', bearer(organizer))).status).toBe(403);
    expect(await Template.countDocuments()).toBe(0);
  });

  it('shows the plan, then installs, and organizers can then pick the templates', async () => {
    const plan = await request(app).get('/api/v1/templates/defaults').set('Authorization', bearer(admin));
    expect(plan.status).toBe(200);
    expect(plan.body.data.templatesToCreate).toHaveLength(DEFAULT_TEMPLATES.length);
    expect(await Template.countDocuments()).toBe(0); // a preview changes nothing

    const installed = await request(app).post('/api/v1/templates/defaults').set('Authorization', bearer(admin));
    expect(installed.status).toBe(200);
    expect(installed.body.data.created).toHaveLength(DEFAULT_TEMPLATES.length);

    const list = await request(app).get('/api/v1/templates').set('Authorization', bearer(organizer));
    expect(list.status).toBe(200);
    expect(list.body.data.map((t: any) => t.name)).toEqual(['Master Card']);
  });

  it('serves each preview image to anyone who can see the template', async () => {
    await installDefaultTemplates(String(admin._id));
    const t = await Template.findOne({ name: 'Master Card' }).lean();
    const res = await request(app).get(`/api/v1/media/${t!.previewImageKey!.slice(6)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('still rejects a malformed template id', async () => {
    expect((await request(app).get('/api/v1/templates/not-an-id').set('Authorization', bearer(admin))).status).toBe(400);
  });
});
