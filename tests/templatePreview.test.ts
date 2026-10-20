import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { Template } from '../src/models/Template';
import { Event } from '../src/models/Event';
import { User, Role } from '../src/models/User';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(120000);

let mongoServer: MongoMemoryServer;
let admin: any, organizer: any, staff: any, published: any, draft: any;
const bearer = (u: any) => `Bearer ${generateAccessToken(String(u._id), u.role)}`;
const preview = (id: string, who: any, body: object = {}) => request(app).post(`/api/v1/templates/${id}/preview`).set('Authorization', bearer(who)).send(body);
const form = { title: 'Moloy Birthday Celebration', startIso: '2026-11-07T18:00:00+05:30', endIso: '2026-11-07T22:00:00+05:30', venue: '24, Shanti Pally', subcategoryName: 'Birthday', categoryName: 'Personal' };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  admin = await User.create({ fullName: 'Root', email: 'root.prev@example.com', role: Role.ADMIN, isActive: true, isEmailVerified: true });
  organizer = await User.create({ fullName: 'Org', email: 'org.prev@example.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  staff = await User.create({ fullName: 'Staff', email: 'staff.prev@example.com', role: Role.SYSTEM_USER, isActive: true, isEmailVerified: true });
  published = await Template.create({ name: 'Birthday Party', cardDesign: 'BIRTHDAY', isPublished: true });
  draft = await Template.create({ name: 'Secret Draft', cardDesign: 'WEDDING', isPublished: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('live card preview for the Add Event form', () => {
  it('renders the template with what the organizer has entered', async () => {
    const res = await preview(String(published._id), organizer, form).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-invitation-qr']).toBe('SAMPLE'); // never a real check-in pass
    const meta = await sharp(res.body).metadata();
    expect([meta.width, meta.height]).toEqual([786, 1364]);
  });

  it('changes when the form changes', async () => {
    const grab = async (body: object) => (await preview(String(published._id), organizer, body).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); })).body as Buffer;
    const a = await grab(form);
    const b = await grab({ ...form, title: 'Riya Birthday Celebration' });
    const same = await grab(form);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(same)).toBe(true);
  });

  it('copes with an empty form (the first moment after choosing a template)', async () => {
    expect((await preview(String(published._id), organizer, {})).status).toBe(200);
  });

  it('is available to organizers and admins only', async () => {
    expect((await request(app).post(`/api/v1/templates/${published._id}/preview`).send({})).status).toBe(401);
    expect((await preview(String(published._id), staff, {})).status).toBe(403);
    expect((await preview(String(published._id), admin, {})).status).toBe(200);
  });

  it('hides unpublished templates from organizers but not from admins', async () => {
    expect((await preview(String(draft._id), organizer, {})).status).toBe(404);
    expect((await preview(String(draft._id), admin, {})).status).toBe(200);
    expect((await preview(String(new mongoose.Types.ObjectId()), admin, {})).status).toBe(404);
  });

  it('rejects anything but short, known fields; an image can only be uploaded media, never a URL', async () => {
    const id = String(published._id);
    expect((await preview(id, organizer, { title: 'x'.repeat(101) })).status).toBe(400);
    expect((await preview(id, organizer, { somethingElse: 'x' })).status).toBe(400);
    expect((await preview(id, organizer, { logoKey: 'https://169.254.169.254/latest/meta-data/' })).status).toBe(400);
    expect((await preview(id, organizer, { logoKey: '/etc/passwd' })).status).toBe(400);
    expect((await preview(id, organizer, { logoKey: `media:${new mongoose.Types.ObjectId()}` })).status).toBe(200); // unknown media: no photo, no error
  });

  it('treats markup and control characters in the text as plain text', async () => {
    const res = await preview(String(published._id), organizer, { title: '<script>alert(1)</script> & "quotes" \u0000\u0007', venue: '<svg onload=x>' });
    expect(res.status).toBe(200);
  });

  it('saves nothing', async () => {
    const before = [await Template.countDocuments(), await Event.countDocuments()];
    await preview(String(published._id), organizer, form);
    expect([await Template.countDocuments(), await Event.countDocuments()]).toEqual(before);
  });
});
