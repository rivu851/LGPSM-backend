import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Media, MediaPurpose } from '../src/models/Media';
import { Template } from '../src/models/Template';
import { generateAccessToken } from '../src/utils/token';
import { invitationService } from '../src/services/invitation.service';

jest.setTimeout(120000);
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });

// A ready (published, shared) admin template with the wording marked: it must work for an organizer in the form's preview, in the event's
// own card preview, and when invitations are drawn, including a template saved before the layout was read.
describe('a ready dynamic template works for organizers everywhere', () => {
  let mongo: MongoMemoryServer; let admin: any; let org: any; let other: any; let event: any; let tpl: any;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  const buf = (r: any, cb: any) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
  const px = async (png: Buffer, x: number, y: number) => [...(await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer())];

  beforeEach(async () => {
    await Promise.all([User, Event, Media, Template].map((m: any) => m.deleteMany({})));
    admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', role: Role.ADMIN, isActive: true });
    org = await User.create({ fullName: 'Org', email: 'org@x.com', role: Role.ORGANIZER, isActive: true });
    other = await User.create({ fullName: 'Other', email: 'other@x.com', role: Role.ORGANIZER, isActive: true });
    // a pink card with a dark bar where the designer printed the event name
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#f6c9d8"/><rect x="140" y="940" width="800" height="120" fill="#222222"/></svg>';
    const data = await sharp(Buffer.from(svg)).png().toBuffer();
    const m = await Media.create({ ownerId: admin._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: 1080, height: 1920, data });
    const made = await request(app).post('/api/v1/templates/upload').set(auth(admin)).send({ name: 'Ready', imageKey: `media:${m._id}` });
    expect(made.status).toBe(201);
    tpl = made.body.data;
    await request(app).put(`/api/v1/templates/${tpl._id}/text-zones`).set(auth(admin)).send({ zones: [{ role: 'title', x: 130, y: 930, w: 820, h: 140, lines: 1, color: '#5a2030', fontFamily: 'Playfair Display', fontWeight: 700, align: 'center' }] });
    const start = new Date(Date.now() + 864e5);
    event = await Event.create({ organizerId: org._id, title: 'Aarav and Meera', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL, location: { address: 'Kolkata' }, schedule: { start, end: new Date(+start + 36e5 * 6) }, status: EventStatus.PUBLISHED, templateId: tpl._id });
  });

  it('an organizer sees it in the template list and previews it with their own title (the old bar is gone)', async () => {
    expect((await request(app).get('/api/v1/templates').set(auth(org))).body.data.map((x: any) => x.name)).toContain('Ready');
    const prev = await request(app).post(`/api/v1/templates/${tpl._id}/preview`).set(auth(org)).send({ title: 'Aarav and Meera' }).buffer(true).parse(buf);
    expect(prev.status).toBe(200);
    expect(await px(prev.body, 135, 935)).toEqual([0xf6, 0xc9, 0xd8]); // the designer's dark bar is painted out
    const area = await sharp(prev.body).extract({ left: 160, top: 960, width: 760, height: 80 }).removeAlpha().raw().toBuffer();
    expect(area.some((v, i) => i % 3 === 0 && v < 200)).toBe(true); // the event's own title is written there
  });

  it('the event\'s own card preview and a drawn invitation use it too (not the default design for the event type)', async () => {
    const { png } = await invitationService.previewInvitationCard(String(event._id), String(org._id));
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
    expect(await px(png, 135, 935)).toEqual([0xf6, 0xc9, 0xd8]);
  });

  it('a template saved before the layout was read (and not marked shared) is repaired and used', async () => {
    // an older admin upload: no layout version, private flag, old fixed layout
    await Template.updateOne({ _id: tpl._id }, { $unset: { 'templateData.layoutVersion': '', 'templateData.textAreas': '' }, isSystemTemplate: false, 'designSpec.elements': [{ type: 'qr', purpose: 'INVITATION', x: 60, y: 1500, size: 291, padding: 0.07, radius: 22 }], 'designSpec.meta': { generator: 'UPLOAD' } });
    const { png } = await invitationService.previewInvitationCard(String(event._id), String(org._id));
    expect((await sharp(png).metadata()).width).toBe(1080);
    const repaired: any = await Template.findById(tpl._id).lean();
    expect(repaired.isSystemTemplate).toBe(true);
    expect(repaired.templateData.layoutVersion).toBe(2);
  });

  it('with the QR switched off, the design\'s own empty QR box goes too', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#f6c9d8"/><rect x="390" y="1000" width="300" height="300" fill="#ffffff" stroke="#5a2030" stroke-width="6"/></svg>';
    const data = await sharp(Buffer.from(svg)).png().toBuffer();
    const m = await Media.create({ ownerId: admin._id, purpose: MediaPurpose.TEMPLATE, contentType: 'image/png', size: data.length, width: 1080, height: 1920, data });
    const made = await request(app).post('/api/v1/templates/upload').set(auth(admin)).send({ name: 'Boxed', imageKey: `media:${m._id}` });
    const on = await request(app).post(`/api/v1/templates/${made.body.data._id}/preview`).set(auth(org)).send({ title: 'Hello', cardDisplay: { qr: true } }).buffer(true).parse(buf);
    const off = await request(app).post(`/api/v1/templates/${made.body.data._id}/preview`).set(auth(org)).send({ title: 'Hello', cardDisplay: { qr: false } }).buffer(true).parse(buf);
    expect(await px(on.body, 392, 1002)).not.toEqual([0xf6, 0xc9, 0xd8]); // the box (and its border) are there
    expect(await px(off.body, 540, 1150)).toEqual([0xf6, 0xc9, 0xd8]); // the middle of the box: plain background again
    expect(await px(off.body, 392, 1002)).toEqual([0xf6, 0xc9, 0xd8]); // and its border
  });
});
