import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Template } from '../src/models/Template';
import { Media, MediaPurpose } from '../src/models/Media';
import { Event } from '../src/models/Event';
import { invitationService } from '../src/services/invitation.service';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });

describe('custom (per-organizer) categories', () => {
  let mongo: MongoMemoryServer; let a: any; let b: any; let admin: any; let corporate: any;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Category.deleteMany({}), Template.deleteMany({}), Media.deleteMany({}), Event.deleteMany({})]);
    a = await User.create({ fullName: 'A', email: 'a@x.com', role: Role.ORGANIZER, isActive: true });
    b = await User.create({ fullName: 'B', email: 'b@x.com', role: Role.ORGANIZER, isActive: true });
    admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', role: Role.ADMIN, isActive: true });
    corporate = await Category.create({ name: 'Corporate', isActive: true, subcategories: [{ name: 'Conference' }] });
  });
  const list = async (u?: any) => (await request(app).get('/api/v1/categories').set(u ? auth(u) : {})).body.data as any[];

  it('an organizer creates a category only they can see', async () => {
    const res = await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'Alumni Meet' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Alumni Meet', isCustom: true });
    expect((await list(a)).map((c) => c.name)).toEqual(['Alumni Meet', 'Corporate']);
    expect((await list(b)).map((c) => c.name)).toEqual(['Corporate']);
    expect((await list()).map((c) => c.name)).toEqual(['Corporate']);
    expect((await list(admin)).map((c) => c.name)).toEqual(['Corporate']);
    // and cannot be fetched by id by anyone else
    expect((await request(app).get(`/api/v1/categories/${res.body.data._id}`).set(auth(b))).status).toBe(404);
    expect((await request(app).get(`/api/v1/categories/${res.body.data._id}`).set(auth(a))).status).toBe(200);
  });

  it('refuses names that repeat what the organizer can already pick, but allows another organizer the same name', async () => {
    expect((await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: ' corporate ' })).status).toBe(409);
    expect((await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'Alumni' })).status).toBe(201);
    expect((await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'ALUMNI' })).status).toBe(409);
    expect((await request(app).post('/api/v1/categories/custom').set(auth(b)).send({ name: 'Alumni' })).status).toBe(201);
  });

  it('only organizers can create custom ones, and the name is limited', async () => {
    expect((await request(app).post('/api/v1/categories/custom').set(auth(admin)).send({ name: 'Nope' })).status).toBe(403);
    expect((await request(app).post('/api/v1/categories/custom')).status).toBe(401);
    expect((await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'x'.repeat(61) })).status).toBe(400);
  });

  it('a custom subcategory goes under the platform category and is visible only to its owner', async () => {
    const res = await request(app).post(`/api/v1/categories/${corporate._id}/custom-subcategories`).set(auth(a)).send({ name: 'Town Hall' });
    expect(res.status).toBe(201);
    const subs = (cs: any[]) => cs.find((c) => c.name === 'Corporate').subcategories.map((s: any) => s.name);
    expect(subs(await list(a))).toEqual(['Conference', 'Town Hall']);
    expect(subs(await list(b))).toEqual(['Conference']);
    expect((await request(app).post(`/api/v1/categories/${corporate._id}/custom-subcategories`).set(auth(a)).send({ name: 'conference' })).status).toBe(409);
  });

  it("an administrator's save of the category does not wipe organizers' custom subcategories", async () => {
    await request(app).post(`/api/v1/categories/${corporate._id}/custom-subcategories`).set(auth(a)).send({ name: 'Town Hall' });
    const visible = (await list(admin)).find((c) => c.name === 'Corporate');
    expect(visible.subcategories.map((s: any) => s.name)).toEqual(['Conference']);
    await request(app).patch(`/api/v1/categories/${corporate._id}`).set(auth(admin)).send({ subcategories: visible.subcategories.map((s: any) => ({ _id: s._id, name: s.name })) });
    expect(((await list(a)).find((c) => c.name === 'Corporate')).subcategories.map((s: any) => s.name)).toEqual(['Conference', 'Town Hall']);
  });

  it("an event cannot use another organizer's custom category", async () => {
    const mine = (await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'Alumni' })).body.data;
    const body = (categoryId: string) => ({ title: 'T', description: 'd', categoryId, format: 'PHYSICAL', location: { address: 'x' }, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) } });
    expect((await request(app).post('/api/v1/events').set(auth(b)).send(body(mine._id))).status).toBe(400);
  });

  describe('names', () => {
    it('the unique index can actually be built, and is enforced per owner', async () => {
      await Category.init(); // let mongoose's own background index build finish first, so the two cannot overlap
      await Category.syncIndexes();
      expect((await Category.collection.indexes()).map((x: any) => x.name)).toContain('owner_scoped_name_unique');
      await expect(Category.create({ name: 'Corporate', isActive: true })).rejects.toMatchObject({ code: 11000 });
      await Category.create({ name: 'Corporate', isActive: true, ownerId: a._id });
      await expect(Category.create({ name: 'Corporate', isActive: true, ownerId: a._id })).rejects.toMatchObject({ code: 11000 });
      await Category.create({ name: 'Corporate', isActive: true, ownerId: b._id });
    });

    it("a private name never blocks the administrator's platform list", async () => {
      await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'Alumni' });
      expect((await request(app).post('/api/v1/categories').set(auth(admin)).send({ name: 'Alumni' })).status).toBe(201);
      await request(app).post(`/api/v1/categories/${corporate._id}/custom-subcategories`).set(auth(a)).send({ name: 'Town Hall' });
      expect((await request(app).post(`/api/v1/categories/${corporate._id}/subcategories`).set(auth(admin)).send({ name: 'Town Hall' })).status).toBe(201);
      // but the platform's own names still cannot repeat
      expect((await request(app).post('/api/v1/categories').set(auth(admin)).send({ name: 'corporate' })).status).toBe(409);
      expect((await request(app).post(`/api/v1/categories/${corporate._id}/subcategories`).set(auth(admin)).send({ name: 'conference' })).status).toBe(409);
    });
  });

  describe('privacy', () => {
    const upload = async (owner: any) => {
      const data = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#cc1122' } }).png().toBuffer();
      const m = await Media.create({ ownerId: owner._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: 800, height: 1200, data });
      return `media:${m._id}`;
    };
    const event = (extra: any = {}) => ({ title: 'Event', description: 'd', categoryId: String(corporate._id), format: 'PHYSICAL', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) }, ...extra });

    it("other organizers' private subcategories are not in template responses", async () => {
      await request(app).post(`/api/v1/categories/${corporate._id}/custom-subcategories`).set(auth(a)).send({ name: 'A-SECRET-SUB' });
      const t = await Template.create({ name: 'Sys', cardDesign: 'WEDDING', categoryId: corporate._id, isPublished: true, isActive: true });
      const list = await request(app).get('/api/v1/templates').set(auth(b));
      const one = await request(app).get(`/api/v1/templates/${t._id}`).set(auth(b));
      expect(JSON.stringify(list.body)).not.toContain('A-SECRET-SUB');
      expect(JSON.stringify(one.body)).not.toContain('A-SECRET-SUB');
      // the category's name is still there for the screens that show it
      expect(list.body.data[0].categoryId.name).toBe('Corporate');
    });

    it("an organizer's private category named General is never used for someone else's event", async () => {
      await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'General' });
      const res = await request(app).post('/api/v1/events').set(auth(b)).send(event({ categoryId: undefined }));
      expect(res.status).toBe(201);
      const saved: any = await Event.findById(res.body.data.eventId).populate('categoryId');
      expect(saved.categoryId.name).toBe('General');
      expect(saved.categoryId.ownerId).toBeUndefined();
    });

    it("changing only the subcategory is checked too: another organizer's private one is refused", async () => {
      const sub = (await request(app).post(`/api/v1/categories/${corporate._id}/custom-subcategories`).set(auth(a)).send({ name: 'Private' })).body.data.subcategories.find((s: any) => s.name === 'Private');
      const created = await request(app).post('/api/v1/events').set(auth(b)).send(event());
      const res = await request(app).patch(`/api/v1/events/${created.body.data.eventId}`).set(auth(b)).send({ subcategoryId: sub._id });
      expect(res.status).toBe(400);
      expect((await Event.findById(created.body.data.eventId))?.subcategoryId).toBeUndefined();
      // the owner can use their own
      const own = await request(app).post('/api/v1/events').set(auth(a)).send(event());
      expect((await request(app).patch(`/api/v1/events/${own.body.data.eventId}`).set(auth(a)).send({ subcategoryId: sub._id })).status).toBe(200);
    });

    it("an organizer cannot point their template at another organizer's custom category", async () => {
      const cat = (await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'A only' })).body.data;
      const t = await request(app).post('/api/v1/templates/upload').set(auth(b)).send({ name: 'Mine', imageKey: await upload(b), categoryId: String(corporate._id) });
      expect((await request(app).patch(`/api/v1/templates/${t.body.data._id}`).set(auth(b)).send({ categoryId: cat._id })).status).toBe(400);
      expect(JSON.stringify((await request(app).get('/api/v1/templates?scope=mine').set(auth(b))).body)).not.toContain('A only');
    });

    it("an admin opening an organizer's event gets its custom category's name and subcategory, without the rest of the list", async () => {
      const cat = (await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'Alumni' })).body.data;
      const withSub = (await request(app).post(`/api/v1/categories/${cat._id}/custom-subcategories`).set(auth(a)).send({ name: 'Class of 2010' })).body.data;
      const created = await request(app).post('/api/v1/events').set(auth(a)).send(event({ categoryId: cat._id, subcategoryId: withSub.subcategories[0]._id }));
      const res = await request(app).get(`/api/v1/events/${created.body.data.eventId}`).set(auth(admin));
      expect(res.body.data.categoryId).toMatchObject({ name: 'Alumni' });
      expect(res.body.data.categoryId.ownerId).toBeTruthy();
      expect(res.body.data.categoryId.subcategories).toBeUndefined();
      expect(res.body.data.subcategory).toMatchObject({ name: 'Class of 2010', isCustom: true });
      // saving the event as admin without changing the category still works
      expect((await request(app).patch(`/api/v1/events/${created.body.data.eventId}`).set(auth(admin)).send({ title: 'Renamed by admin', categoryId: cat._id, subcategoryId: withSub.subcategories[0]._id })).status).toBe(200);
    });
  });

  describe('a design an admin uploaded, used on an organizer\'s event', () => {
    const upload = async (owner: any) => {
      const data = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#123456' } }).png().toBuffer();
      const m = await Media.create({ ownerId: owner._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: 800, height: 1200, data });
      return `media:${m._id}`;
    };
    const event = (extra: any = {}) => ({ title: 'Event', description: 'd', categoryId: String(corporate._id), format: 'PHYSICAL', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) }, ...extra });
    const adminDesign = async () => (await request(app).post('/api/v1/templates/upload').set(auth(admin)).send({ name: 'Admin design', imageKey: await upload(admin), categoryId: String(corporate._id) })).body.data;

    it('is kept: each organizer gets one copy of their own, and the card uses it', async () => {
      const t = await adminDesign();
      const first = await request(app).post('/api/v1/events').set(auth(admin)).send(event({ organizerIds: [String(a._id), String(b._id)], templateId: t._id }));
      expect(first.status).toBe(201);
      const [evA, evB]: any[] = await Promise.all(first.body.data.eventIds.map((id: string) => Event.findById(id)));
      expect(String(evA.templateId)).not.toBe(t._id);
      const copyA: any = await Template.findById(evA.templateId);
      expect(String(copyA.ownerId)).toBe(String(a._id));
      expect(copyA.isSystemTemplate).toBe(false);
      expect(String((await Template.findById(evB.templateId))?.ownerId)).toBe(String(b._id));

      // a second event for the same organizer reuses the copy
      const second = await request(app).post('/api/v1/events').set(auth(admin)).send(event({ organizerIds: [String(a._id)], templateId: t._id }));
      expect(String((await Event.findById(second.body.data.eventId))?.templateId)).toBe(String(copyA._id));
      expect(await Template.countDocuments({ ownerId: a._id })).toBe(1);

      // the organizer sees it as theirs, and the other organizer never sees theirs
      const mine = await request(app).get('/api/v1/templates').set(auth(a));
      expect(mine.body.data.map((x: any) => x._id)).toContain(String(copyA._id));
      expect(mine.body.data.map((x: any) => x._id)).not.toContain(String(evB.templateId));

      // the card really is the uploaded design (custom canvas), not the fallback for the event type (786 wide)
      const { png } = await invitationService.previewInvitationCard(String(evA._id), String(a._id));
      expect((await sharp(png).metadata()).width).not.toBe(786);
    });

    it('also works when an admin changes the template while editing, and the original can be deleted safely', async () => {
      const created = await request(app).post('/api/v1/events').set(auth(admin)).send(event({ organizerIds: [String(a._id)] }));
      const t = await adminDesign();
      expect((await request(app).patch(`/api/v1/events/${created.body.data.eventId}`).set(auth(admin)).send({ templateId: t._id })).status).toBe(200);
      const saved: any = await Event.findById(created.body.data.eventId);
      expect(String((await Template.findById(saved.templateId))?.ownerId)).toBe(String(a._id));
      await request(app).delete(`/api/v1/templates/${t._id}`).set(auth(admin));
      expect((await Template.findById(saved.templateId))?.isActive).toBe(true);
    });

    it("an organizer's private design is still refused on someone else's event, and an organizer cannot use another's", async () => {
      const own = (await request(app).post('/api/v1/templates/upload').set(auth(a)).send({ name: 'A design', imageKey: await upload(a), categoryId: String(corporate._id) })).body.data;
      const onB = await request(app).post('/api/v1/events').set(auth(admin)).send(event({ organizerIds: [String(b._id)], templateId: own._id }));
      expect((await Event.findById(onB.body.data.eventId))?.templateId).toBeUndefined();
      const byB = await request(app).post('/api/v1/events').set(auth(b)).send(event({ templateId: own._id }));
      expect((await Event.findById(byB.body.data.eventId))?.templateId).toBeUndefined();
      expect(await Template.countDocuments({ ownerId: b._id })).toBe(0);
    });
  });

  describe('scripts/migrate-category-uniqueness.js', () => {
    const script = path.join(__dirname, '..', 'scripts', 'migrate-category-uniqueness.js');
    // run from a temp folder so the developer's .env is never read; ATLAS_URL points at this test's throwaway database
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: os.tmpdir(), env: { PATH: process.env.PATH, ATLAS_URL: mongo.getUri() }, encoding: 'utf8' });
    const reset = async (seed: () => Promise<unknown>) => {
      const col = mongoose.connection.collection('categories');
      await col.dropIndexes();
      await col.deleteMany({});
      await seed();
      return col;
    };
    const names = async (col: any) => (await col.indexes()).map((i: any) => i.name);

    it('report mode changes nothing; apply swaps the old index for the new one and is safe to repeat', async () => {
      const col = await reset(async () => {
        await mongoose.connection.collection('categories').createIndex({ name: 1 }, { unique: true, name: 'name_1' });
        await mongoose.connection.collection('categories').insertMany([{ name: 'Corporate' }, { name: 'Personal' }]);
      });
      expect(run().status).toBe(0);
      expect(await names(col)).toContain('name_1');
      expect(run('--apply').status).toBe(0);
      expect(await names(col)).toEqual(expect.arrayContaining(['owner_scoped_name_unique']));
      expect(await names(col)).not.toContain('name_1');
      expect(await col.countDocuments()).toBe(2);
      expect(run('--apply').status).toBe(0);
      // names are now per owner
      await col.insertOne({ name: 'Corporate', ownerId: new mongoose.Types.ObjectId() });
      await expect(col.insertOne({ name: 'Corporate' })).rejects.toMatchObject({ code: 11000 });
    });

    it('repairs a database left without any unique index, and replaces the index from the earlier code', async () => {
      const col = await reset(async () => {
        await mongoose.connection.collection('categories').createIndex({ ownerId: 1, name: 1 }, { unique: true, partialFilterExpression: { ownerId: { $exists: true } }, name: 'owner_name_unique' });
        await mongoose.connection.collection('categories').insertOne({ name: 'Corporate' });
      });
      expect(run('--apply').status).toBe(0);
      expect(await names(col)).toContain('owner_scoped_name_unique');
      expect(await names(col)).not.toContain('owner_name_unique');
    });

    it('stops without changing anything when existing data would break the new index', async () => {
      const col = await reset(async () => { await mongoose.connection.collection('categories').insertMany([{ name: 'Dup' }, { name: 'Dup' }]); });
      const res = run('--apply');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Dup');
      expect(await names(col)).not.toContain('owner_scoped_name_unique');
      await col.deleteMany({});
    });

    afterAll(async () => { await Category.syncIndexes(); });
  });

  describe('an organizer deleting their own custom entries', () => {
    const png = async (owner: any) => {
      const data = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#123456' } }).png().toBuffer();
      const m = await Media.create({ ownerId: owner._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: 800, height: 1200, data });
      return `media:${m._id}`;
    };
    const event = (extra: any = {}) => ({ title: 'Event', description: 'd', categoryId: String(corporate._id), format: 'PHYSICAL', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) }, ...extra });
    const mk = async (name = 'Alumni') => (await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name })).body.data;
    const mkSub = async (categoryId: unknown, name = 'Town Hall') => (await request(app).post(`/api/v1/categories/${categoryId}/custom-subcategories`).set(auth(a)).send({ name })).body.data.subcategories.find((x: any) => x.name === name);

    it('the category leaves the list, and events using it keep it', async () => {
      const cat = await mk();
      const created = await request(app).post('/api/v1/events').set(auth(a)).send(event({ categoryId: cat._id }));
      expect((await request(app).delete(`/api/v1/categories/custom/${cat._id}`).set(auth(a))).status).toBe(200);
      expect((await list(a)).map((c) => c.name)).toEqual(['Corporate']);
      // the event still reads the same, for its owner and for an admin
      for (const who of [a, admin]) {
        const res = await request(app).get(`/api/v1/events/${created.body.data.eventId}`).set(auth(who));
        expect(res.body.data.categoryId.name).toBe('Alumni');
      }
      // and can still be saved without changing it
      expect((await request(app).patch(`/api/v1/events/${created.body.data.eventId}`).set(auth(a)).send({ title: 'Renamed', categoryId: cat._id })).status).toBe(200);
    });

    it('a deleted category cannot be chosen for a new event, an edit or an upload', async () => {
      const cat = await mk();
      const other = await request(app).post('/api/v1/events').set(auth(a)).send(event());
      await request(app).delete(`/api/v1/categories/custom/${cat._id}`).set(auth(a));
      expect((await request(app).post('/api/v1/events').set(auth(a)).send(event({ categoryId: cat._id }))).status).toBe(400);
      expect((await request(app).patch(`/api/v1/events/${other.body.data.eventId}`).set(auth(a)).send({ categoryId: cat._id })).status).toBe(400);
      expect((await request(app).post('/api/v1/templates/upload').set(auth(a)).send({ name: 'Design', imageKey: await png(a), categoryId: cat._id })).status).toBe(400);
    });

    it('their templates under it become general templates, and stay usable', async () => {
      const cat = await mk();
      const sub = await mkSub(cat._id);
      const t = (await request(app).post('/api/v1/templates/upload').set(auth(a)).send({ name: 'Design', imageKey: await png(a), categoryId: cat._id, subcategoryId: sub._id })).body.data;
      await request(app).delete(`/api/v1/categories/custom/${cat._id}`).set(auth(a));
      const saved: any = await Template.findById(t._id);
      expect(saved.categoryId).toBeUndefined();
      expect(saved.subcategoryId).toBeUndefined();
      expect(saved.isActive).toBe(true);
      const created = await request(app).post('/api/v1/events').set(auth(a)).send(event({ templateId: t._id }));
      expect(String((await Event.findById(created.body.data.eventId))?.templateId)).toBe(t._id);
    });

    it('adding the same name again brings back the same category, so old events stay linked', async () => {
      const cat = await mk('Alumni');
      await request(app).delete(`/api/v1/categories/custom/${cat._id}`).set(auth(a));
      const back = await request(app).post('/api/v1/categories/custom').set(auth(a)).send({ name: 'ALUMNI' });
      expect(back.status).toBe(201);
      expect(back.body.data._id).toBe(cat._id);
      expect(back.body.data.name).toBe('ALUMNI');
      expect((await list(a)).map((c) => c.name)).toEqual(['ALUMNI', 'Corporate']);
      expect(await Category.countDocuments({ ownerId: a._id })).toBe(1);
    });

    it('a subcategory on a platform category: gone from the list, kept on events, chosen again only after being re-added', async () => {
      const sub = await mkSub(corporate._id);
      const created = await request(app).post('/api/v1/events').set(auth(a)).send(event({ subcategoryId: sub._id }));
      const del = await request(app).delete(`/api/v1/categories/${corporate._id}/custom-subcategories/${sub._id}`).set(auth(a));
      expect(del.status).toBe(200);
      const res = await request(app).get(`/api/v1/events/${created.body.data.eventId}`).set(auth(a));
      expect(res.body.data.subcategory.name).toBe('Town Hall');
      expect((await request(app).post('/api/v1/events').set(auth(a)).send(event({ subcategoryId: sub._id }))).status).toBe(400);
      const again = await mkSub(corporate._id);
      expect(again._id).toBe(sub._id);
      expect(again.isActive).toBe(true);
      expect((await request(app).post('/api/v1/events').set(auth(a)).send(event({ subcategoryId: sub._id }))).status).toBe(201);
    });

    it('nobody can delete what is not theirs', async () => {
      const cat = await mk();
      const sub = await mkSub(corporate._id);
      const platformSub = (corporate as any).subcategories[0]._id;
      // another organizer, by id
      expect((await request(app).delete(`/api/v1/categories/custom/${cat._id}`).set(auth(b))).status).toBe(404);
      expect((await request(app).delete(`/api/v1/categories/${corporate._id}/custom-subcategories/${sub._id}`).set(auth(b))).status).toBe(404);
      // the platform's own
      expect((await request(app).delete(`/api/v1/categories/custom/${corporate._id}`).set(auth(a))).status).toBe(404);
      expect((await request(app).delete(`/api/v1/categories/${corporate._id}/custom-subcategories/${platformSub}`).set(auth(a))).status).toBe(404);
      // not signed in, wrong role, bad id
      expect((await request(app).delete(`/api/v1/categories/custom/${cat._id}`)).status).toBe(401);
      expect((await request(app).delete(`/api/v1/categories/custom/${cat._id}`).set(auth(admin))).status).toBe(403);
      expect((await request(app).delete('/api/v1/categories/custom/not-an-id').set(auth(a))).status).toBe(404);
      expect((await request(app).delete(`/api/v1/categories/${corporate._id}/custom-subcategories/not-an-id`).set(auth(a))).status).toBe(404);
      // all still there; deleting twice is reported, not repeated
      expect((await list(a)).map((c) => c.name)).toEqual(['Alumni', 'Corporate']);
      expect((await request(app).delete(`/api/v1/categories/custom/${cat._id}`).set(auth(a))).status).toBe(200);
      expect((await request(app).delete(`/api/v1/categories/custom/${cat._id}`).set(auth(a))).status).toBe(404);
    });

    it("the administrator's global delete route still refuses organizers", async () => {
      expect((await request(app).delete(`/api/v1/categories/${corporate._id}`).set(auth(a))).status).toBe(403);
    });
  });
});
