import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { generateAccessToken } from '../src/utils/token';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('organization details on the organizer profile', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(() => User.deleteMany({}));

  const mk = (role: Role, profile?: any) => User.create({ fullName: 'P', email: `${role}@x.com`, role, isActive: true, profile });
  const patch = (u: any, body: any) => request(app).patch('/api/users/profile').set(auth(generateAccessToken(String(u._id), u.role))).send(body);

  it('saves organization fields without touching the personal name or the logo', async () => {
    const org = await mk(Role.ORGANIZER, { logoKey: 'logo-1', organizationName: 'Old' });
    const res = await patch(org, { organization: { name: 'Acme', phone: '+91 98765 43210', email: 'hi@acme.com', address: '1 Road', website: 'https://acme.com' } });
    expect(res.status).toBe(200);
    const saved: any = await User.findById(org._id).lean();
    expect(saved.fullName).toBe('P');
    expect(saved.profile.logoKey).toBe('logo-1');
    expect(saved.profile.organizationName).toBe('Acme');
    expect(saved.profile.organization).toEqual({ phone: '+91 98765 43210', email: 'hi@acme.com', address: '1 Road', website: 'https://acme.com' });
  });

  it('rejects an invalid email, website, or an empty name', async () => {
    const org = await mk(Role.ORGANIZER);
    expect((await patch(org, { organization: { name: 'A', email: 'nope' } })).status).toBe(400);
    expect((await patch(org, { organization: { name: 'A', website: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await patch(org, { organization: { name: ' ' } })).status).toBe(400);
  });

  it('is not available to staff accounts', async () => {
    const staff = await mk(Role.SYSTEM_USER);
    expect((await patch(staff, { organization: { name: 'Mine' } })).status).toBe(403);
  });

  it('an email that is already an invitee can also be a staff login, and the invitee record is untouched', async () => {
    const org = await mk(Role.ORGANIZER);
    const eventId = new mongoose.Types.ObjectId();
    const guest = await Invitee.create({ eventId, name: 'Guest', email: 'shared@x.com', invitationStatus: InvitationStatus.SENT, rsvpStatus: RsvpStatus.ACCEPTED, sessionAccess: [] });
    const res = await request(app).post('/api/users/').set(auth(generateAccessToken(String(org._id), org.role)))
      .send({ fullName: 'Door Staff', email: 'shared@x.com', password: 'Str0ng!Passw0rd', role: 'SYSTEM_USER' });
    expect(res.status).toBeLessThan(300);
    const after: any = await Invitee.findById(guest._id).lean();
    expect(after.rsvpStatus).toBe(RsvpStatus.ACCEPTED);
    expect(after.name).toBe('Guest');
    expect(await User.countDocuments({ email: 'shared@x.com', role: Role.SYSTEM_USER })).toBe(1);
  });
});
