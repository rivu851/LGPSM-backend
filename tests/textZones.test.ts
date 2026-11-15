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
    expect(classifyLines([L('SAVE THE DATE', 271, 853, 809, 901), L('You are invited', 200, 700, 880, 760)], canvas)).toEqual({ title: undefined, dateTime: undefined, venue: undefined });
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
    expect(both.zones.map((z) => z.role)).toEqual(['title', 'dateTime']);
    expect(both.zones[0].align).toBe('center');
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
    expect(before.body.data.zones).toEqual([]);
    expect(before.body.data.mode).toBe('NONE');

    const put = await request(app).put(`/api/v1/templates/${id}/text-zones`).set(auth()).send({ zones: [{ role: 'title', x: 130, y: 930, w: 820, h: 140, lines: 1, color: '#5a2030', fontFamily: 'Playfair Display', fontWeight: 700, align: 'center' }] });
    expect(put.status).toBe(200);
    expect((await request(app).get(`/api/v1/templates/${id}/text-zones`).set(auth())).body.data).toMatchObject({ mode: 'MANUAL', zones: [{ role: 'title', align: 'center' }] });

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
