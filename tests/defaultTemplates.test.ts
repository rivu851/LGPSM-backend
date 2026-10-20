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

describe('installing the designers\' default templates', () => {
  it('plans every template and category on an empty database, without writing anything', async () => {
    const plan = await planDefaultTemplates();
    expect(plan.templatesToCreate.map((t) => t.name).sort()).toEqual(DEFAULT_TEMPLATES.map((t) => t.name).sort());
    expect(plan.categoriesToCreate.sort()).toEqual(['Corporate', 'General', 'Personal', 'Technology']);
    expect(await Template.countDocuments()).toBe(0);
    expect(await Category.countDocuments()).toBe(0);
  });

  it('works on a database like the live one and leaves what exists exactly as it was', async () => {
    const personal = await Category.create({ name: 'Personal', isActive: true, subcategories: [{ name: 'Birthday' }] });
    await Category.create({ name: 'Technology', isActive: true });
    await Category.create({ name: 'General', isActive: true });
    const birthdayId = (personal as any).subcategories[0]._id;
    const existing = await Template.create({ name: 'Bday Template 1', categoryId: personal._id, subcategoryId: birthdayId });
    const before = await Template.findById(existing._id).lean();

    const plan = await planDefaultTemplates();
    expect(plan.categoriesToCreate).toEqual(['Corporate']);
    expect(plan.subcategoriesToCreate).toEqual(expect.arrayContaining([{ category: 'Personal', subcategory: 'Wedding' }, { category: 'Personal', subcategory: 'Rice Ceremony' }]));

    const result = await installDefaultTemplates(String(admin._id));
    expect(result.created.sort()).toEqual(DEFAULT_TEMPLATES.map((t) => t.name).sort());

    expect(await Template.findById(existing._id).lean()).toEqual(before); // untouched
    const after = await Category.findById(personal._id);
    expect(after!.subcategories.map((s) => s.name).sort()).toEqual(['Birthday', 'Rice Ceremony', 'Wedding']);
    expect(String(after!.subcategories.find((s) => s.name === 'Birthday')!._id)).toBe(String(birthdayId)); // same id: events keep pointing at it
    expect(await Category.countDocuments({ name: /^personal$/i })).toBe(1); // no duplicate category
  });

  it('creates published templates mapped to the right event type, each with a preview image', async () => {
    await installDefaultTemplates(String(admin._id));
    const templates = await Template.find({}).lean();
    expect(templates).toHaveLength(DEFAULT_TEMPLATES.length);
    const birthday = templates.find((t) => t.name === 'Birthday Party')!;
    expect(birthday).toMatchObject({ cardDesign: 'BIRTHDAY', isPublished: true, isActive: true, isSystemTemplate: true });
    const personal = await Category.findOne({ name: 'Personal' });
    expect(String(birthday.categoryId)).toBe(String(personal!._id));
    expect(String(birthday.subcategoryId)).toBe(String(personal!.subcategories.find((s) => s.name === 'Birthday')!._id));

    for (const t of templates) {
      expect(t.previewImageKey).toMatch(/^media:[0-9a-f]{24}$/);
      const media = await Media.findById(t.previewImageKey!.slice(6)).select('+data');
      expect(media!.contentType).toBe('image/jpeg');
      const meta = await sharp(media!.data).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBeGreaterThan(300);
    }
  });

  it('is safe to run again: nothing is created twice', async () => {
    await installDefaultTemplates(String(admin._id));
    const second = await installDefaultTemplates(String(admin._id));
    expect(second.created).toEqual([]);
    expect(await Template.countDocuments()).toBe(DEFAULT_TEMPLATES.length);
    expect(await Media.countDocuments()).toBe(DEFAULT_TEMPLATES.filter((d, i, a) => a.findIndex((x) => x.key === d.key) === i).length);
    expect((await planDefaultTemplates()).templatesToCreate).toEqual([]);
  });

  it('matches category names ignoring case and does not create a second one', async () => {
    await Category.create({ name: 'personal', isActive: true, subcategories: [{ name: 'BIRTHDAY' }] });
    await installDefaultTemplates(String(admin._id));
    expect(await Category.countDocuments({ name: /^personal$/i })).toBe(1);
    expect((await Category.findOne({ name: /^personal$/i }))!.subcategories.filter((s) => /^birthday$/i.test(s.name))).toHaveLength(1);
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
    expect(list.body.data.map((t: any) => t.name)).toEqual(expect.arrayContaining(['Birthday Party', 'Rice Ceremony', 'Wedding Reception', 'Corporate Awards']));
  });

  it('serves each preview image to anyone who can see the template', async () => {
    await installDefaultTemplates(String(admin._id));
    const t = await Template.findOne({ name: 'Rice Ceremony' }).lean();
    const res = await request(app).get(`/api/v1/media/${t!.previewImageKey!.slice(6)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('still rejects a malformed template id', async () => {
    expect((await request(app).get('/api/v1/templates/not-an-id').set('Authorization', bearer(admin))).status).toBe(400);
  });
});
