// Uploaded images can be kept as files in MEDIA_DIR instead of inside the database; either way they are served from the same address, and
// switching the setting never makes an image unreadable.
import request from 'supertest';
import mongoose from 'mongoose';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Media } from '../src/models/Media';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(60000);
let mongo: MongoMemoryServer; let org: any; let dir: string; let png: Buffer;
const auth = () => ({ Authorization: `Bearer ${generateAccessToken(String(org._id), org.role)}` });
const upload = () => request(app).post('/api/v1/media/upload').set(auth()).field('purpose', 'EVENT_LOGO').attach('file', png, { filename: 'logo.png', contentType: 'image/png' });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 101, b: 29, alpha: 0.5 } } }).png().toBuffer();
});
afterAll(async () => { delete process.env.MEDIA_DIR; delete process.env.MEDIA_PUBLIC_URL; delete process.env.PUBLIC_API_URL; await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Media.deleteMany({})]);
  org = await User.create({ fullName: 'Org', email: 'o@x.com', role: Role.ORGANIZER, isActive: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgpsm-media-'));
});
afterEach(() => { delete process.env.MEDIA_DIR; delete process.env.MEDIA_PUBLIC_URL; delete process.env.PUBLIC_API_URL; fs.rmSync(dir, { recursive: true, force: true }); });

describe('MEDIA_DIR set', () => {
  it('uploads a profile photo as multipart, persists its key, and returns it on profile reload', async () => {
    process.env.MEDIA_DIR = dir;
    process.env.MEDIA_PUBLIC_URL = 'https://media.example.com';
    const uploaded = await request(app)
      .patch('/api/users/profile/photo')
      .set(auth())
      .attach('file', png, { filename: 'avatar.png', contentType: 'image/png' });

    expect(uploaded.status).toBe(200);
    const key = uploaded.body.data.profile.avatarKey as string;
    expect(key).toMatch(/^media:[0-9a-f]{24}$/);
    expect(uploaded.body.data.profile.avatarUrl).toMatch(/^https:\/\/media\.example\.com\/[0-9a-f]{24}\.png$/);

    const saved = await User.findById(org._id).lean() as any;
    expect(saved.profile.avatarKey).toBe(key);

    const profile = await request(app).get('/api/users/profile').set(auth());
    expect(profile.status).toBe(200);
    expect(profile.body.data.profile.avatarKey).toBe(key);
    expect(profile.body.data.profile.avatarUrl).toBe(uploaded.body.data.profile.avatarUrl);
  });

  it('keeps the bytes in a file, leaves them out of the database, and serves the image', async () => {
    process.env.MEDIA_DIR = dir;
    const res = await upload();
    expect(res.status).toBe(201);
    const id = String(res.body.data.key).replace('media:', '');
    const rec: any = await Media.findById(id).select('+data storage fileName').lean();
    expect(rec.storage).toBe('DISK');
    expect(rec.data).toBeUndefined();
    expect(fs.existsSync(path.join(dir, rec.fileName))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const got = await request(app).get(`/api/v1/media/${id}`);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toMatch(/image\/png/);
    expect((await sharp(got.body).metadata()).width).toBe(64);
  });

  it('answers 404 (not an error) when the file has gone missing', async () => {
    process.env.MEDIA_DIR = dir;
    const id = String((await upload()).body.data.key).replace('media:', '');
    const rec: any = await Media.findById(id).lean();
    fs.unlinkSync(path.join(dir, rec.fileName));
    expect((await request(app).get(`/api/v1/media/${id}`)).status).toBe(404);
  });

  it('still serves an image that was saved in the database earlier', async () => {
    const id = String((await upload()).body.data.key).replace('media:', ''); // saved in the database (no MEDIA_DIR yet)
    expect(((await Media.findById(id).lean()) as any).storage).toBe('DB');
    process.env.MEDIA_DIR = dir;
    expect((await request(app).get(`/api/v1/media/${id}`)).status).toBe(200);
  });
});

describe('MEDIA_DIR not set', () => {
  it('keeps the bytes in the database as before', async () => {
    const id = String((await upload()).body.data.key).replace('media:', '');
    const rec: any = await Media.findById(id).select('+data storage').lean();
    expect(rec.storage).toBe('DB');
    expect(Buffer.isBuffer(rec.data) || rec.data?.buffer).toBeTruthy();
    expect((await request(app).get(`/api/v1/media/${id}`)).status).toBe(200);
  });

  it('a file left in the folder is never read through a crafted file name', async () => {
    process.env.MEDIA_DIR = dir;
    const id = String((await upload()).body.data.key).replace('media:', '');
    await Media.updateOne({ _id: id }, { $set: { fileName: '../../etc/passwd' } });
    expect((await request(app).get(`/api/v1/media/${id}`)).status).toBe(404);
  });
});

describe('MEDIA_PUBLIC_URL set (files served from the media address)', () => {
  afterEach(() => { delete process.env.MEDIA_PUBLIC_URL; });

  it('sends the browser to the file on the media address, and keeps the old address working', async () => {
    process.env.MEDIA_DIR = dir; process.env.MEDIA_PUBLIC_URL = 'https://media.example.com/';
    const uploaded = await upload();
    const id = String(uploaded.body.data.key).replace('media:', '');
    const rec: any = await Media.findById(id).lean();
    expect(uploaded.body.data.publicUrl).toBe(`https://media.example.com/${rec.fileName}`);
    const res = await request(app).get(`/api/v1/media/${id}`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`https://media.example.com/${rec.fileName}`);
  });

  it('does not redirect to a file that is not there (404 instead of a dead link)', async () => {
    process.env.MEDIA_DIR = dir; process.env.MEDIA_PUBLIC_URL = 'https://media.example.com';
    const id = String((await upload()).body.data.key).replace('media:', '');
    fs.unlinkSync(path.join(dir, ((await Media.findById(id).lean()) as any).fileName));
    expect((await request(app).get(`/api/v1/media/${id}`).redirects(0)).status).toBe(404);
  });

  it('images still kept in the database are served by the API, not redirected', async () => {
    const id = String((await upload()).body.data.key).replace('media:', ''); // database copy
    process.env.MEDIA_DIR = dir; process.env.MEDIA_PUBLIC_URL = 'https://media.example.com';
    const res = await request(app).get(`/api/v1/media/${id}`).redirects(0);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\//);
  });

  it('ignores an address that is not https (the API serves the bytes)', async () => {
    process.env.MEDIA_DIR = dir; process.env.MEDIA_PUBLIC_URL = 'http://media.example.com';
    const id = String((await upload()).body.data.key).replace('media:', '');
    expect((await request(app).get(`/api/v1/media/${id}`).redirects(0)).status).toBe(200);
  });
});
