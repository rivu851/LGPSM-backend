// What a guest's invitation email really contains when it goes out through Brevo's HTTPS API: every image address in the HTML must be
// a public https link that answers with an image (no `cid:` left, nothing blocked), so the logo, the details icons, the card and the QR show.
process.env.BREVO_API_KEY = 'test-key';
process.env.BREVO_SENDER = 'LGPSM <no-reply@example.com>';
process.env.PUBLIC_API_URL = 'https://api.example.com';
import request from 'supertest';
import mongoose from 'mongoose';
import fs from 'fs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee } from '../src/models/Invitee';
import { generateAccessToken } from '../src/utils/token';

jest.setTimeout(90000);
const BASE = 'https://api.example.com';
let mongo: MongoMemoryServer;
beforeAll(async () => {
  process.env.BREVO_API_KEY = 'test-key'; process.env.BREVO_SENDER = 'LGPSM <no-reply@example.com>'; process.env.PUBLIC_API_URL = BASE;
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
});
afterAll(async () => { delete process.env.BREVO_API_KEY; delete process.env.BREVO_SENDER; delete process.env.PUBLIC_API_URL; await mongoose.disconnect(); await mongo.stop(); });

it('an invitation email has only public https image links, and each answers with an image', async () => {
  const org: any = await User.create({ fullName: 'Org', email: 'o@x.com', role: Role.ORGANIZER, isActive: true, profile: { organizationName: 'Iconic Events' } });
  const cat = await Category.create({ name: 'Corporate', isActive: true });
  const ev: any = await Event.create({ organizerId: org._id, title: 'Summit', description: 'd', categoryId: cat._id, format: EventFormat.PHYSICAL, status: EventStatus.PUBLISHED, contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) }, rsvp: { enabled: true } });
  await Session.create({ eventId: ev._id, name: 'Main', schedule: ev.schedule, accessControl: AccessControl.NO_RESTRICTION, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST });
  const guest: any = await Invitee.create({ eventId: ev._id, name: 'Guest One', email: 'g@x.com', mobile: '9876543210' });

  const sent: any[] = [];
  const realFetch = global.fetch;
  global.fetch = jest.fn(async (url: any, init: any) => {
    if (String(url).startsWith('https://api.brevo.com')) { sent.push(JSON.parse(init.body)); return { ok: true, status: 201, json: async () => ({}) } as any; }
    return realFetch(url, init);
  }) as any;
  const tok = generateAccessToken(String(org._id), org.role);
  const res = await request(app).post(`/api/v1/events/${ev._id}/invitations/send`).set({ Authorization: `Bearer ${tok}` }).send({ inviteeIds: [String(guest._id)], channel: 'EMAIL' });
  global.fetch = realFetch;
  expect(res.status).toBe(200);
  expect(sent).toHaveLength(1);

  const html: string = sent[0].htmlContent;
  fs.writeFileSync(process.env.EMAIL_DUMP || '/tmp/invitation-email.html', html);
  const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  console.log('IMG SRCS:\n' + srcs.join('\n') + `\nATTACHMENTS: ${(sent[0].attachment || []).map((a: any) => a.name).join(', ') || 'none'}`);
  expect(html).not.toMatch(/cid:/);
  expect(srcs.length).toBeGreaterThan(0);
  for (const src of srcs) {
    expect(src.startsWith(`${BASE}/`)).toBe(true);
    const r = await request(app).get(src.slice(BASE.length));
    console.log(r.status, r.headers['content-type'], r.body?.length ?? 0, src.replace(/invitations\/[^/]+/, 'invitations/<token>'));
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/^image\//);
    expect(r.body.length).toBeGreaterThan(100);
  }
});
