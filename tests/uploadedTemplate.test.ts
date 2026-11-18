import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Media, MediaPurpose } from '../src/models/Media';
import { Template } from '../src/models/Template';
import { generateAccessToken } from '../src/utils/token';
import { presetFor, buildDynamicUploadedSpec } from '../src/services/cardTemplates/uploadedTemplate';
import { loadCardContext } from '../src/services/cardTemplates/context';
import { decodeQr } from './helpers/qr';

jest.setTimeout(60000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });

describe('upload your own template', () => {
  let mongo: MongoMemoryServer; let a: any; let b: any; let admin: any;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Media.deleteMany({}), Template.deleteMany({})]);
    a = await User.create({ fullName: 'A', email: 'a@x.com', role: Role.ORGANIZER, isActive: true });
    b = await User.create({ fullName: 'B', email: 'b@x.com', role: Role.ORGANIZER, isActive: true });
    admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', role: Role.ADMIN, isActive: true });
  });
  // a plain red 800x1200 design
  const upload = async (owner: any, w = 800, h = 1200) => {
    const data = await sharp({ create: { width: w, height: h, channels: 3, background: '#cc1122' } }).png().toBuffer();
    const m = await Media.create({ ownerId: owner._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: w, height: h, data });
    return `media:${m._id}`;
  };
  const make = (u: any, body: object) => request(app).post('/api/v1/templates/upload').set(auth(u)).send(body);

  it('picks the canvas closest to the picture', () => {
    expect(presetFor(800, 1200)).toBe('INVITATION_PORTRAIT'); // 2:3 is nearer 9:16 than 4:5
    expect(presetFor(1000, 1250)).toBe('INVITATION_CARD');
    expect(presetFor(1000, 1000)).toBe('INVITATION_SQUARE');
    expect(presetFor()).toBe('INVITATION_CARD');
  });

  it('turns an organizer\'s own image into a private template whose card is that image exactly as it is (no QR code added)', async () => {
    const key = await upload(a);
    const res = await make(a, { name: 'My Gala Card', imageKey: key });
    expect(res.status).toBe(201);
    const t = await Template.findById(res.body.data._id).lean();
    expect(t).toMatchObject({ name: 'My Gala Card', cardDesign: 'CUSTOM', kind: 'INVITATION', isSystemTemplate: false, previewImageKey: key, templateData: { uploaded: true } });
    expect(String(t!.ownerId)).toBe(String(a._id));

    // only its owner sees it
    const mine = await request(app).get('/api/v1/templates').set(auth(a));
    expect(mine.body.data.map((x: any) => x.name)).toContain('My Gala Card');
    expect((await request(app).get('/api/v1/templates').set(auth(b))).body.data.map((x: any) => x.name)).not.toContain('My Gala Card');
    // an admin does not see an organizer's private upload either
    expect((await request(app).get('/api/v1/templates').set(auth(admin))).body.data.map((x: any) => x.name)).not.toContain('My Gala Card');

    // the card: the uploaded picture fills it, and the QR code on top scans
    const prev = await request(app).post(`/api/v1/templates/${res.body.data._id}/preview`).set(auth(a)).send({ title: 'Anything', cardInfo: { primary: 'INVITEE_NAME', secondary: null } }).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(prev.status).toBe(200);
    const meta = await sharp(prev.body).metadata();
    // the 1080 x 1920 picture, plus the details strip every card carries (reserved even with nothing in it, so the size never changes)
    expect(meta.width).toBe(1080);
    expect(meta.height!).toBeGreaterThanOrEqual(1920);
    const px = await sharp(prev.body).extract({ left: 20, top: 20, width: 1, height: 1 }).raw().toBuffer();
    expect([...px].slice(0, 3)).toEqual([0xcc, 0x11, 0x22]);
    expect(await decodeQr(prev.body)).toBeNull();
  });

  it('an admin upload is dynamic and shared at once: organizers can use it, and once its wording is found or marked the event\'s details replace that wording', async () => {
    const key = await upload(admin);
    const res = await make(admin, { name: 'Admin Dynamic', imageKey: key });
    expect(res.status).toBe(201);
    let t: any = await Template.findById(res.body.data._id).lean();
    expect(t.templateData).toMatchObject({ uploaded: true, dynamicDetails: true, textAreas: 'NONE' });
    // a plain red picture has no wording to find: nothing is drawn over the picture (and the guest's name is not added: no place for it)
    expect(t.designSpec.elements.filter((e: any) => e.type === 'text')).toEqual([]);
    expect(t.isPublished).toBe(true);
    // shared with every organizer, who can preview it with their own event's details
    expect((await request(app).get('/api/v1/templates').set(auth(a))).body.data.map((x: any) => x.name)).toContain('Admin Dynamic');
    expect((await request(app).post(`/api/v1/templates/${res.body.data._id}/preview`).set(auth(a)).send({ title: 'Mine' })).status).toBe(200);
    // admins' own uploads are listed for admins
    expect((await request(app).get('/api/v1/templates').set(auth(admin))).body.data.map((x: any) => x.name)).toContain('Admin Dynamic');

    // marking the title area makes the event's title replace the wording there
    const zone = { role: 'title', x: 100, y: 800, w: 880, h: 160, lines: 1, color: '#ffffff', fontFamily: 'Inter', fontWeight: 700, align: 'center' };
    expect((await request(app).put(`/api/v1/templates/${res.body.data._id}/text-zones`).set(auth(admin)).send({ zones: [zone] })).status).toBe(200);
    t = await Template.findById(res.body.data._id).lean();
    expect(t.designSpec.elements.filter((e: any) => e.type === 'text').map((e: any) => e.role)).toEqual(['title']);
    // an organizer's upload stays the finished design, as it is
    const org: any = await Template.findById((await make(a, { name: 'Org Plain', imageKey: await upload(a) })).body.data._id).lean();
    expect(org.designSpec.elements.some((e: any) => e.role === 'title')).toBe(false);

    const body = { title: 'Dynamic Gala Night', startIso: '2027-03-05T12:30:00.000Z', venue: 'Grand Hall' };
    const render = (extra: object) => request(app).post(`/api/v1/templates/${res.body.data._id}/preview`).set(auth(admin)).send({ ...body, ...extra }).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    const full = await render({});
    const hidden = await render({ cardDisplay: { title: false } });
    expect(full.status).toBe(200);
    expect(hidden.status).toBe(200);
    expect(Buffer.compare(full.body, hidden.body)).not.toBe(0);
    expect(await decodeQr(full.body)).toMatch(/^https?:\/\//);
  });

  it('an organizer\'s upload saved by an older version (with a QR code and a name zone in it) is now drawn as the plain picture', async () => {
    // the design has a white QR box in the middle; the old saved layout put the code and the name at the bottom-left
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#f6c9d8"/><rect x="390" y="1000" width="300" height="300" fill="#ffffff" stroke="#5a2030" stroke-width="6"/></svg>';
    const data = await sharp(Buffer.from(svg)).png().toBuffer();
    const m = await Media.create({ ownerId: a._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: 1080, height: 1920, data });
    const t = await Template.create({
      name: 'Old upload', cardDesign: 'CUSTOM', kind: 'INVITATION', previewImageKey: `media:${m._id}`, ownerId: a._id, isSystemTemplate: false, isPublished: true, isActive: true, templateData: { uploaded: true },
      designSpec: {
        version: 1, kind: 'INVITATION', canvas: { preset: 'INVITATION_PORTRAIT', width: 1080, height: 1920 }, background: '#000000', backgroundMedia: `media:${m._id}`,
        palette: { background: '#000000', primary: '#111111', accent: '#FF651D', text: '#111111' },
        elements: [
          { type: 'rect', x: 100, y: 1400, w: 880, h: 400, radius: 30, fill: '#FFFFFF', opacity: 0.94, strokeWidth: 0 },
          { type: 'qr', purpose: 'INVITATION', x: 60, y: 1500, size: 291, padding: 0.07, radius: 22 },
          { type: 'text', role: 'inviteeName', x: 400, y: 1500, w: 600, h: 80, align: 'left', valign: 'middle', fontFamily: 'Inter', fontWeight: 700, size: 52, lineHeight: 1.12, letterSpacing: 0, uppercase: false, maxLines: 1, color: '#111111', opacity: 1 }
        ],
        meta: { generator: 'UPLOAD' }
      }
    });
    const prev = await request(app).post(`/api/v1/templates/${t._id}/preview`).set(auth(a)).send({ title: 'Anything', cardInfo: { primary: 'INVITEE_NAME', secondary: null } }).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(prev.status).toBe(200);
    // nothing drawn at the old bottom-left spot: it is the plain picture
    const old = await sharp(prev.body).extract({ left: 60, top: 1500, width: 291, height: 291 }).removeAlpha().raw().toBuffer();
    expect(old.every((v, i) => (i % 3 === 0 ? v === 0xf6 : i % 3 === 1 ? v === 0xc9 : v === 0xd8))).toBe(true);
    // and no code appears anywhere else on it either (an organizer's own design is sent exactly as it is)
    const box = await sharp(prev.body).extract({ left: 400, top: 1010, width: 280, height: 280 }).png().toBuffer();
    expect(await decodeQr(box)).toBeNull();
  });

  it('needs no name and no category: an unnamed upload gets a dated name and suits every event type', async () => {
    const res = await make(a, { imageKey: await upload(a) });
    expect(res.status).toBe(201);
    const t: any = await Template.findById(res.body.data._id).lean();
    expect(t.name).toMatch(/^Uploaded template \d{2} \w{3} \d{4}$/);
    expect(t.categoryId).toBeUndefined();
  });

  it('refuses an image someone else uploaded, a missing image, and other roles\' paths', async () => {
    const bs = await upload(b);
    expect((await make(a, { name: 'Stolen', imageKey: bs })).status).toBe(400);
    expect((await make(a, { name: 'None', imageKey: `media:${new mongoose.Types.ObjectId()}` })).status).toBe(400);
    expect((await make(a, { name: 'Bad', imageKey: 'https://example.com/x.png' })).status).toBe(400);
    expect((await make(a, { name: 'x', imageKey: bs })).status).toBe(400);
    expect(await Template.countDocuments({})).toBe(0);
    const staff = await User.create({ fullName: 'S', email: 's@x.com', role: Role.SYSTEM_USER, isActive: true });
    expect((await make(staff, { name: 'Staff Template', imageKey: await upload(staff) })).status).toBe(403);
  });

  it('draws nothing on an organizer\'s own static design, even one saved by an older version with a QR code and wording in it', async () => {
    const key = await upload(a);
    // an older version stored the organizer's picture with a QR code on it (the layout an admin\'s dynamic upload has)
    const legacy = buildDynamicUploadedSpec(key, 800, 1200, false, []);
    expect(legacy.elements.some((e: any) => e.type === 'qr')).toBe(true);
    const t: any = await Template.create({ name: 'Old static', cardDesign: 'CUSTOM', kind: 'INVITATION', designSpec: legacy, previewImageKey: key, ownerId: a._id, isSystemTemplate: false, isPublished: true, isActive: true, templateData: { uploaded: true } });
    const ctx = await loadCardContext({ templateId: t._id, organizerId: a._id, categoryId: undefined, title: 'E' } as any);
    expect(ctx.cardDesign).toBe('CUSTOM');
    expect(ctx.designSpec?.elements).toEqual([]);
    expect(ctx.designSpec?.meta.plain).toBe(true);
    // an admin's dynamic upload is untouched: it keeps its QR code
    const dynamic: any = await Template.create({ name: 'Admin dynamic', cardDesign: 'CUSTOM', kind: 'INVITATION', designSpec: legacy, previewImageKey: key, ownerId: admin._id, isSystemTemplate: true, isPublished: true, isActive: true, templateData: { uploaded: true, dynamicDetails: true, textAreas: 'NONE', layoutVersion: 2 } });
    const ctx2 = await loadCardContext({ templateId: dynamic._id, organizerId: a._id, title: 'E' } as any);
    expect(ctx2.designSpec?.elements.some((e: any) => e.type === 'qr')).toBe(true);
  });
});
