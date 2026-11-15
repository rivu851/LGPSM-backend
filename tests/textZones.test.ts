import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Media, MediaPurpose } from '../src/models/Media';
import { Template } from '../src/models/Template';
import { generateAccessToken } from '../src/utils/token';
import { classifyLines, detectTextZones, RecognisedLine } from '../src/services/cardTemplates/textZones';
import { paintOutAreas } from '../src/services/cardTemplates/specRenderer';

jest.setTimeout(120000);
const L = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90): RecognisedLine => ({ text, confidence, x0, y0, x1, y1 });
const canvas = { width: 1080, height: 1920 };

describe('finding the wording in an uploaded design', () => {
  it('sorts lines into title, date and time, and venue; leaves "Save the date" alone', () => {
    const r = classifyLines([
      L('SAVE THE DATE', 271, 853, 809, 901),
      L('Moloy & Dola', 91, 949, 991, 1067),
      L('Wednesday 28 DEC', 200, 1459, 880, 1511),
      L('at 12:30 PM', 360, 1520, 720, 1566),
      L('Tollygunge, Kolkata - 700107', 221, 1640, 855, 1685),
      L('xx', 10, 10, 30, 30, 20)
    ], canvas);
    expect(r.title!.map((l) => l.text)).toEqual(['Moloy & Dola']);
    expect(r.dateTime!.map((l) => l.text)).toEqual(['Wednesday 28 DEC', 'at 12:30 PM']);
    expect(r.venue!.map((l) => l.text)).toEqual(['Tollygunge, Kolkata - 700107']);
  });
  it('finds nothing when the picture has no such wording', () => {
    const r = classifyLines([L('SAVE THE DATE', 271, 853, 809, 901), L('You are invited', 200, 700, 880, 760)], canvas);
    expect([r.title, r.dateTime, r.venue]).toEqual([undefined, undefined, undefined]);
    expect(r.decorative.length).toBe(2); // left as the designer made them
  });
  it('says "not detected" (and does not throw) when the picture cannot be read', async () => {
    const png = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#eeeeee' } }).png().toBuffer();
    const r = await detectTextZones(png, canvas, async () => { throw new Error('no engine'); });
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/could not be read/);
  });
  it('detected needs the title and one more detail', async () => {
    const png = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#f6c9d8' } }).png().toBuffer();
    const only = await detectTextZones(png, canvas, async () => [L('Moloy & Dola', 91, 949, 991, 1067)]);
    expect(only.detected).toBe(false);
    const both = await detectTextZones(png, canvas, async () => [L('Moloy & Dola', 91, 949, 991, 1067), L('Wednesday 28 DEC at 12:30 PM', 107, 1459, 970, 1511)]);
    expect(both.detected).toBe(true);
    // the QR code always has a place too (here the quietest spot of the plain picture)
    expect(both.zones.map((z) => z.role)).toEqual(['title', 'dateTime', 'qr']);
    expect(both.zones.find((z) => z.role === 'qr')!.frame).toBe(false);
    expect(both.zones[0].align).toBe('center');
  });
});

describe('script lettering and partial finds', () => {
  const plain = () => sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#f6c9d8' } }).png().toBuffer();
  it('a decorative title that is misread is still found by its size and place', async () => {
    const r = await detectTextZones(await plain(), canvas, async () => [
      L('SAVE THE DATE', 271, 1000, 809, 1050, 85),
      L('Moloy 8 Dola', 220, 1090, 860, 1230, 22), // script lettering: read badly, box correct
      L('Wednesday 28 DEC at 12:30 PM', 150, 1500, 930, 1560, 80),
      L('Venue - 24, Shanti Pally, Kolkata - 700107', 100, 1620, 980, 1670, 80)
    ]);
    expect(r.detected).toBe(true);
    expect(r.zones.map((z) => z.role)).toEqual(expect.arrayContaining(['title', 'dateTime', 'venue']));
  });
  it('all or nothing: when the title is not found, no wording is replaced at all (a half-replaced card is worse than none)', async () => {
    const r = await detectTextZones(await plain(), canvas, async () => [L('Venue - 24, Shanti Pally, Kolkata - 700107', 100, 1620, 980, 1670, 80)]);
    expect(r.detected).toBe(false);
    expect(r.zones.map((z) => z.role)).toEqual(['qr']);
  });
});

describe('where the QR code goes', () => {
  it('goes in the design\'s own empty QR box', async () => {
    // a pink card with a white square QR box (dark border) in the middle and a round white photo frame above it
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#f6c9d8"/><circle cx="540" cy="520" r="250" fill="#fff"/><rect x="380" y="1000" width="320" height="320" fill="#ffffff" stroke="#5a2030" stroke-width="6"/></svg>';
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const r = await detectTextZones(png, canvas, async () => [L('Scan the QR code', 400, 1340, 680, 1380)]);
    const qr = r.zones.find((z) => z.role === 'qr')!;
    expect(qr.frame).toBe(true);
    // inside the box (not the round frame above it)
    expect(qr.x).toBeGreaterThanOrEqual(380); expect(qr.x + qr.w).toBeLessThanOrEqual(700);
    expect(qr.y).toBeGreaterThanOrEqual(1000); expect(qr.y + qr.h).toBeLessThanOrEqual(1320);
  });
  it('with no box, the quietest spot of the picture, away from the wording and not on busy artwork', async () => {
    // busy flowers across the top half (stripes), plain below
    const stripes = Array.from({ length: 60 }, (_, i) => `<rect x="${i * 18}" y="0" width="9" height="960" fill="#c0507a"/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#f6c9d8"/>${stripes}</svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const r = await detectTextZones(png, canvas, async () => [L('Moloy & Dola', 91, 1100, 991, 1200), L('Wednesday 28 DEC', 200, 1260, 880, 1310)]);
    const qr = r.zones.find((z) => z.role === 'qr')!;
    expect(qr.frame).toBe(false);
    expect(qr.y).toBeGreaterThan(960); // not on the stripes
    const hitsWording = (z: { x: number; y: number; w: number; h: number }) => qr.x < z.x + z.w && qr.x + qr.w > z.x && qr.y < z.y + z.h && qr.y + qr.h > z.y;
    expect(r.zones.filter((z) => z.role !== 'qr').some(hitsWording)).toBe(false);
  });
  it('the guest\'s name and details are added only where the design printed a place for them', async () => {
    const png = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#f6c9d8' } }).png().toBuffer();
    const none = await detectTextZones(png, canvas, async () => [L('Moloy & Dola', 91, 949, 991, 1067), L('Wednesday 28 DEC', 200, 1459, 880, 1511)]);
    expect(none.zones.some((z) => z.role === 'inviteeName' || z.role === 'inviteeMeta')).toBe(false);
    const some = await detectTextZones(png, canvas, async () => [L('Moloy & Dola', 91, 949, 991, 1067), L('Wednesday 28 DEC', 200, 1459, 880, 1511), L('Guest Name', 300, 1700, 780, 1760), L('Company Name', 300, 1780, 780, 1830)]);
    expect(some.zones.map((z) => z.role)).toEqual(expect.arrayContaining(['inviteeName', 'inviteeMeta']));
  });
});

describe('painting old wording out of the picture', () => {
  it('refills the box from its surroundings and leaves the rest of the picture alone', async () => {
    // a soft top-to-bottom gradient with a dark bar standing in for the old wording
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6c9d8"/><stop offset="1" stop-color="#c9a0b8"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><rect x="100" y="180" width="200" height="40" fill="#222222"/></svg>';
    const picture = await sharp(Buffer.from(svg)).png().toBuffer();
    const out = await paintOutAreas(picture, [{ x: 90, y: 170, w: 220, h: 60 }]);
    const px = async (img: Buffer, x: number, y: number) => [...(await sharp(img).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer())];
    const old = await px(picture, 200, 200);
    const now = await px(out, 200, 200);
    expect(old[0]).toBeLessThan(60); // the old wording was dark
    expect(now[0]).toBeGreaterThan(190); // now it is background
    // and the neighbours outside the box are byte-for-byte what they were
    expect(await px(out, 50, 50)).toEqual(await px(picture, 50, 50));
    expect(await px(out, 350, 350)).toEqual(await px(picture, 350, 350));
  });
});

describe('an admin upload: the event\'s details replace the wording in place', () => {
  let mongo: MongoMemoryServer; let admin: any;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => { await Promise.all([User.deleteMany({}), Media.deleteMany({}), Template.deleteMany({})]); admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', role: Role.ADMIN, isActive: true }); });
  const auth = () => ({ Authorization: `Bearer ${generateAccessToken(String(admin._id), admin.role)}` });
  const buf = (r: any, cb: any) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };

  it('marked areas: the old wording is gone, new wording is drawn there, and nothing else of the picture changes', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#f6c9d8"/><rect x="140" y="940" width="800" height="120" fill="#222222"/><rect x="40" y="40" width="60" height="60" fill="#0044aa"/></svg>';
    const data = await sharp(Buffer.from(svg)).png().toBuffer();
    const m = await Media.create({ ownerId: admin._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: 1080, height: 1920, data });
    const made = await request(app).post('/api/v1/templates/upload').set(auth()).send({ name: 'Gala', imageKey: `media:${m._id}` });
    expect(made.status).toBe(201);
    const id = made.body.data._id;
    // the stand-in picture has no readable wording: nothing is detected, the admin is asked to mark the areas
    const before = await request(app).get(`/api/v1/templates/${id}/text-zones`).set(auth());
    expect(before.body.data.zones.map((z: any) => z.role)).toEqual(['qr']); // only the QR code's place
    expect(before.body.data.mode).toBe('NONE');

    const put = await request(app).put(`/api/v1/templates/${id}/text-zones`).set(auth()).send({ zones: [{ role: 'title', x: 130, y: 930, w: 820, h: 140, lines: 1, color: '#5a2030', fontFamily: 'Playfair Display', fontWeight: 700, align: 'center' }] });
    expect(put.status).toBe(200);
    const after = (await request(app).get(`/api/v1/templates/${id}/text-zones`).set(auth())).body.data;
    expect(after.mode).toBe('MANUAL');
    expect(after.zones.map((z: any) => z.role).sort()).toEqual(['qr', 'title']);

    const prev = await request(app).post(`/api/v1/templates/${id}/preview`).set(auth()).send({ title: 'Moloy Dola Wedding', startIso: '2030-11-11T07:30:00Z', endIso: '2030-11-12T07:30:00Z', venue: 'Kolkata' }).buffer(true).parse(buf);
    expect(prev.status).toBe(200);
    const px = async (x: number, y: number) => [...(await sharp(prev.body).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer())];
    // where the old dark bar sat (at its edge, away from the new letters) it is background again; an untouched corner square is unchanged
    expect(await px(135, 935)).toEqual([0xf6, 0xc9, 0xd8]);
    expect(await px(60, 60)).toEqual([0x00, 0x44, 0xaa]);
    // new wording was drawn: some pixel in the area is no longer the plain background
    const area = await sharp(prev.body).extract({ left: 160, top: 960, width: 760, height: 80 }).removeAlpha().raw().toBuffer();
    expect(area.some((v, i) => i % 3 === 0 && v < 200)).toBe(true);
    // the card is the picture's size: no band added
    expect((await sharp(prev.body).metadata()).height).toBe(1920);
  });

  it('with nothing entered yet the preview still shows where each detail goes, and an old admin upload is read once when first previewed', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#f6c9d8"/></svg>';
    const data = await sharp(Buffer.from(svg)).png().toBuffer();
    const m = await Media.create({ ownerId: admin._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: 1080, height: 1920, data });
    // an admin upload saved before the wording was read: no text areas recorded, an old fixed layout
    const t = await Template.create({
      name: 'Old admin upload', cardDesign: 'CUSTOM', kind: 'INVITATION', previewImageKey: `media:${m._id}`, ownerId: admin._id, isSystemTemplate: true, isPublished: true, isActive: true, templateData: { uploaded: true, dynamicDetails: true },
      designSpec: { version: 1, kind: 'INVITATION', canvas: { preset: 'INVITATION_PORTRAIT', width: 1080, height: 1920 }, background: '#000000', backgroundMedia: `media:${m._id}`, palette: { background: '#000000', primary: '#111111', accent: '#FF651D', text: '#111111' }, elements: [{ type: 'qr', purpose: 'INVITATION', x: 60, y: 1500, size: 291, padding: 0.07, radius: 22 }], meta: { generator: 'UPLOAD' } }
    });
    const first = await request(app).post(`/api/v1/templates/${t._id}/preview`).set(auth()).send({ title: '' }).buffer(true).parse(buf);
    expect(first.status).toBe(200);
    const read: any = await Template.findById(t._id).lean();
    expect(read.templateData.textAreas).toBe('NONE'); // read now (nothing to find in a plain picture)
    expect(read.designSpec.elements.find((e: any) => e.type === 'qr').id).toBe('qr');

    // with areas set and no event details entered, the preview fills them with what will go there
    await request(app).put(`/api/v1/templates/${t._id}/text-zones`).set(auth()).send({ zones: [{ role: 'title', x: 100, y: 800, w: 880, h: 140, lines: 1, color: '#5a2030', fontFamily: 'Inter', fontWeight: 700, align: 'center' }, { role: 'dateTime', x: 100, y: 1000, w: 880, h: 90, lines: 1, color: '#5a2030', fontFamily: 'Inter', fontWeight: 600, align: 'center' }, { role: 'venue', x: 100, y: 1120, w: 880, h: 90, lines: 1, color: '#5a2030', fontFamily: 'Inter', fontWeight: 500, align: 'center' }] });
    const prev = await request(app).post(`/api/v1/templates/${t._id}/preview`).set(auth()).send({}).buffer(true).parse(buf);
    expect(prev.status).toBe(200);
    for (const [name, top] of [['title', 800], ['dateTime', 1000], ['venue', 1120]] as const) {
      const area = await sharp(prev.body).extract({ left: 100, top, width: 880, height: 80 }).removeAlpha().raw().toBuffer();
      expect(area.some((v, i) => i % 3 === 0 && v < 200)).toBe(true); // something is written there: ${name}
    }
  });

  it('only the owner can read or change the areas', async () => {
    const other = await User.create({ fullName: 'B', email: 'b@x.com', role: Role.ADMIN, isActive: true });
    const data = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const m = await Media.create({ ownerId: admin._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: 1080, height: 1920, data });
    const made = await request(app).post('/api/v1/templates/upload').set(auth()).send({ imageKey: `media:${m._id}` });
    const intruder = { Authorization: `Bearer ${generateAccessToken(String(other._id), other.role)}` };
    expect((await request(app).get(`/api/v1/templates/${made.body.data._id}/text-zones`).set(intruder)).status).toBe(404);
    expect((await request(app).put(`/api/v1/templates/${made.body.data._id}/text-zones`).set(intruder).send({ zones: [] })).status).toBe(404);
  });
});
