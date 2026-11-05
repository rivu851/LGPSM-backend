import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Media, MediaPurpose } from '../src/models/Media';
import { Template } from '../src/models/Template';
import { generateAccessToken } from '../src/utils/token';
import { presetFor } from '../src/services/cardTemplates/uploadedTemplate';
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

  it('turns an organizer\'s own image into a private template whose card is that image with the guest QR on it', async () => {
    const key = await upload(a);
    const res = await make(a, { name: 'My Gala Card', imageKey: key });
    expect(res.status).toBe(201);
    const t = await Template.findById(res.body.data._id).lean();
    expect(t).toMatchObject({ name: 'My Gala Card', cardDesign: 'CUSTOM', kind: 'INVITATION', isSystemTemplate: false, previewImageKey: key, templateData: { uploaded: true } });
    expect(String(t!.ownerId)).toBe(String(a._id));

    // only its owner (and admins) see it
    const mine = await request(app).get('/api/v1/templates').set(auth(a));
    expect(mine.body.data.map((x: any) => x.name)).toContain('My Gala Card');
    expect((await request(app).get('/api/v1/templates').set(auth(b))).body.data.map((x: any) => x.name)).not.toContain('My Gala Card');

    // the card: the uploaded picture fills it, and the QR code on top scans
    const prev = await request(app).post(`/api/v1/templates/${res.body.data._id}/preview`).set(auth(a)).send({ title: 'Anything', cardInfo: { primary: 'INVITEE_NAME', secondary: null } }).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(prev.status).toBe(200);
    const meta = await sharp(prev.body).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
    const px = await sharp(prev.body).extract({ left: 20, top: 20, width: 1, height: 1 }).raw().toBuffer();
    expect([...px].slice(0, 3)).toEqual([0xcc, 0x11, 0x22]);
    expect(await decodeQr(prev.body)).toMatch(/^https?:\/\//);
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
});
