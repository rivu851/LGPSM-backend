/**
 * The organizer's logo in the invitation email: the LGPSM logo until the organizer uploads their organization logo
 * (Settings > Logo), then theirs, for every invitation and reminder sent after that. Goes through the real routes the Settings
 * page uses (upload, then save the profile). Mail is mocked: nothing is sent.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { Invitation, DeliveryChannel } from '../src/models/Invitation';
import { Category } from '../src/models/Category';
import { invitationService } from '../src/services/invitation.service';
import { generateAccessToken } from '../src/utils/token';

const mockSendEmail = jest.fn().mockResolvedValue(true);
jest.mock('../src/utils/email.provider', () => ({ sendEmail: (...a: any[]) => mockSendEmail(...a) }));
jest.setTimeout(90000);

let mongo: MongoMemoryServer; let org: any; let event: any;
const auth = () => ({ Authorization: `Bearer ${generateAccessToken(String(org._id), org.role)}` });
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  mockSendEmail.mockClear();
  await Promise.all([User.deleteMany({}), Event.deleteMany({}), Invitee.deleteMany({}), Invitation.deleteMany({}), Category.deleteMany({})]);
  org = await User.create({ fullName: 'Rina Das', email: 'org@x.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true, profile: { organizationName: 'Iconic Events' } });
  const cat = await Category.create({ name: 'Corporate', isActive: true });
  event = await Event.create({ organizerId: org._id, title: 'Summit', description: 'd', categoryId: cat._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 2 * 864e5) } });
});

const sendOne = async (email: string) => {
  const g: any = await Invitee.create({ eventId: event._id, name: 'Guest', email, sessionAccess: [] });
  mockSendEmail.mockClear();
  await invitationService.sendInvitations(String(event._id), String(org._id), [String(g._id)], DeliveryChannel.EMAIL);
  const [, , html, attachments] = mockSendEmail.mock.calls[0];
  return { html: html as string, attachments: attachments as any[], id: String(g._id) };
};

describe("the organizer's logo in the invitation email", () => {
  it('shows the LGPSM logo until a logo is uploaded, then the organization logo in its place', async () => {
    const before = await sendOne('first@x.com');
    expect(before.html).toContain('src="cid:lgpsm-logo"');
    expect(before.attachments.some((a) => a.cid === 'lgpsm-logo')).toBe(true);

    // what Settings > Logo does: upload the picture, then save it on the profile
    const logo = await sharp({ create: { width: 240, height: 120, channels: 3, background: '#123C8F' } }).png().toBuffer();
    const up = await request(app).post('/api/v1/media/upload').set(auth()).field('purpose', 'ORGANIZATION_LOGO').attach('file', logo, { filename: 'logo.png', contentType: 'image/png' });
    expect(up.status).toBeLessThan(300);
    const key = up.body.data.key;
    expect(key).toMatch(/^media:[0-9a-f]{24}$/);
    const saved = await request(app).patch('/api/users/profile').set(auth()).send({ profile: { organizationName: 'Iconic Events', logoKey: key } });
    expect(saved.status).toBe(200);

    const after = await sendOne('second@x.com');
    const cid = `organizer-logo-${after.id}`;
    expect(after.html).toContain(`src="cid:${cid}"`); // at the top, where the LGPSM logo was
    expect(after.html).not.toContain('cid:lgpsm-logo');
    expect(after.attachments.some((a) => a.cid === 'lgpsm-logo')).toBe(false);
    const att = after.attachments.find((a) => a.cid === cid);
    expect(att).toBeDefined();
    const meta = await sharp(att.content).metadata();
    expect(meta.width).toBeGreaterThan(0); // the organizer's picture itself
    expect(after.html).toContain('alt="Iconic Events logo"');
    // beside the logo: the organization's name, because this organizer has set one
    expect(after.html).toMatch(/<img src="cid:organizer-logo-[^>]*\/><\/td>\s*<td[^>]*>Iconic Events<\/td>/);
  });

  it('with no organization name set, the logo stands alone (no name beside it)', async () => {
    await User.updateOne({ _id: org._id }, { $unset: { 'profile.organizationName': '' } });
    const e = await sendOne('noname@x.com');
    expect(e.html).toContain('src="cid:lgpsm-logo"');
    expect(e.html).not.toMatch(/cid:lgpsm-logo"[^>]*\/><\/td>\s*<td/);
  });

  it('goes back to the LGPSM logo when the organizer removes theirs', async () => {
    const logo = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#E3340F' } }).png().toBuffer();
    const up = await request(app).post('/api/v1/media/upload').set(auth()).field('purpose', 'ORGANIZATION_LOGO').attach('file', logo, { filename: 'logo.png', contentType: 'image/png' });
    await request(app).patch('/api/users/profile').set(auth()).send({ profile: { organizationName: 'Iconic Events', logoKey: up.body.data.key } });
    expect((await sendOne('a@x.com')).html).not.toContain('cid:lgpsm-logo');
    // Settings > Logo "Remove": the profile is saved without the logo
    await request(app).patch('/api/users/profile').set(auth()).send({ profile: { organizationName: 'Iconic Events' } });
    expect((await sendOne('b@x.com')).html).toContain('src="cid:lgpsm-logo"');
  });
});
