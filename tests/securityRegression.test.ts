import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { Category } from '../src/models/Category';
import { Template } from '../src/models/Template';
import { CheckIn, CheckInMethod } from '../src/models/CheckIn';
import { generateAccessToken, generatePasswordResetToken } from '../src/utils/token';
import { Session } from '../src/models/Session';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';

jest.mock('../src/utils/email.provider', () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
}));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

async function registerAndLogin(fullName: string, email: string, role: string) {
  await request(app).post('/api/auth/register').send({ fullName, email, password: 'Password123!', role });
  await User.updateOne({ email }, { isEmailVerified: true });
  return request(app).post('/api/auth/login').send({ email, password: 'Password123!', role });
}

describe('Auth & RBAC regression', () => {
  it('never promotes a user through the login role field', async () => {
    await registerAndLogin('Plain Organizer', 'plain.organizer@example.com', 'ORGANIZER');

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'plain.organizer@example.com', password: 'Password123!', role: 'ADMIN' });

    expect(res.status).toBe(403);
    const stored = await User.findOne({ email: 'plain.organizer@example.com' });
    expect(stored?.role).toBe(Role.ORGANIZER);
  });

  it('does not infer ADMIN from an email or name containing "admin"', async () => {
    const res = await registerAndLogin('Admin Lookalike', 'administrator.lookalike@example.com', 'ORGANIZER');
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe(Role.ORGANIZER);
  });

  it('limits organizers to managing SYSTEM_USER accounts', async () => {
    const admin = await User.create({ fullName: 'Root', email: 'root@example.com', role: Role.ADMIN });
    const organizer = await User.create({ fullName: 'Org', email: 'org.rbac@example.com', role: Role.ORGANIZER });
    const staff = await User.create({ fullName: 'Staff', email: 'staff.rbac@example.com', role: Role.SYSTEM_USER, createdBy: organizer._id });
    const otherStaff = await User.create({ fullName: 'Other Staff', email: 'other.staff.rbac@example.com', role: Role.SYSTEM_USER });
    const organizerToken = generateAccessToken((organizer._id as any).toString(), Role.ORGANIZER);

    const editAdmin = await request(app)
      .patch(`/api/users/${admin._id}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ password: 'Hijacked123!' });
    expect(editAdmin.status).toBe(403);

    const deleteAdmin = await request(app)
      .delete(`/api/users/${admin._id}`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(deleteAdmin.status).toBe(403);

    const editStaff = await request(app)
      .patch(`/api/users/${staff._id}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ phone: '+919999999999' });
    expect(editStaff.status).toBe(200);

    const list = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.every((u: any) => u.role === Role.SYSTEM_USER)).toBe(true);
    // Staff created by someone else (and not on this organizer's events) is invisible and unmanageable
    expect(list.body.data.some((u: any) => u.email === 'other.staff.rbac@example.com')).toBe(false);
    const editOther = await request(app)
      .patch(`/api/users/${otherStaff._id}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ phone: '+919999999990' });
    expect(editOther.status).toBe(404);
  });

  it('rejects unknown fields and weak passwords on user update', async () => {
    const organizer = await User.create({ fullName: 'Org2', email: 'org2.rbac@example.com', role: Role.ORGANIZER });
    const staff = await User.create({ fullName: 'Staff2', email: 'staff2.rbac@example.com', role: Role.SYSTEM_USER, createdBy: organizer._id });
    const token = generateAccessToken((organizer._id as any).toString(), Role.ORGANIZER);

    const res = await request(app)
      .patch(`/api/users/${staff._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(400);
    const stored = await User.findById(staff._id);
    expect(stored?.role).toBe(Role.SYSTEM_USER);
  });
});

describe('Error mapping regression', () => {
  it('returns 400 for malformed ObjectIds instead of 500', async () => {
    const organizer = await User.create({ fullName: 'Org3', email: 'org3@example.com', role: Role.ORGANIZER });
    const token = generateAccessToken((organizer._id as any).toString(), Role.ORGANIZER);

    const res = await request(app).get('/api/v1/events/not-an-id').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('returns 401 for a malformed refresh token', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: 'garbage' });
    expect(res.status).toBe(401);
  });
});

describe('Reports regression', () => {
  it('counts check-ins and distinct attendees from real CheckIn records', async () => {
    const organizer = await User.create({ fullName: 'Org4', email: 'org4@example.com', role: Role.ORGANIZER });
    const token = generateAccessToken((organizer._id as any).toString(), Role.ORGANIZER);
    const event = await Event.create({
      organizerId: organizer._id,
      title: 'Report Event',
      description: 'desc',
      categoryId: new mongoose.Types.ObjectId(),
      format: 'PHYSICAL',
      schedule: { start: new Date(), end: new Date(Date.now() + 3600e3) }
    });
    const invitee = await Invitee.create({ eventId: event._id, name: 'Guest', email: 'guest.report@example.com' });
    await Invitee.create({ eventId: event._id, name: 'Guest 2', email: 'guest2.report@example.com' });
    await CheckIn.create({
      eventId: event._id,
      inviteeId: invitee._id,
      checkInMethod: CheckInMethod.QR,
      checkedInBy: organizer._id
    });

    const res = await request(app).get(`/api/v1/reports/events/${event._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalCheckIns).toBe(1);
    expect(res.body.data.uniqueAttendees).toBe(1);
    expect(res.body.data.checkInMethods.QR).toBe(1);
    expect(res.body.data.attendanceRate).toBe('50.00%');

    const dash = await request(app).get('/api/v1/reports/dashboard').set('Authorization', `Bearer ${token}`);
    expect(dash.body.data.totalCheckIns).toBe(1);
  });
});

describe('Password flows regression', () => {
  it('requires the current password to change it', async () => {
    const login = await registerAndLogin('Pw Owner', 'pw.owner@example.com', 'ORGANIZER');
    const token = login.body.data.accessToken;

    const wrong = await request(app)
      .patch('/api/users/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'not-my-password', newPassword: 'BrandNew123!' });
    expect(wrong.status).toBe(400);

    const ok = await request(app)
      .patch('/api/users/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'Password123!', newPassword: 'BrandNew123!' });
    expect(ok.status).toBe(200);

    const relogin = await request(app).post('/api/auth/login').send({ email: 'pw.owner@example.com', password: 'BrandNew123!' });
    expect(relogin.status).toBe(200);
  });

  it('does not accept an access token as a password reset token (and vice versa)', async () => {
    const user = await User.findOne({ email: 'pw.owner@example.com' });
    const accessToken = generateAccessToken((user!._id as any).toString(), Role.ORGANIZER);
    const withAccess = await request(app).post('/api/auth/reset-password').send({ token: accessToken, newPassword: 'Hijacked123!' });
    expect(withAccess.status).toBe(401);

    const resetToken = generatePasswordResetToken((user!._id as any).toString(), Role.ORGANIZER);
    const asBearer = await request(app).get('/api/users/profile').set('Authorization', `Bearer ${resetToken}`);
    expect(asBearer.status).toBe(401);

    const reset = await request(app).post('/api/auth/reset-password').send({ token: resetToken, newPassword: 'ResetWorks123!' });
    expect(reset.status).toBe(200);
  });
});

describe('System user session access regression', () => {
  it('lets assigned staff read only their assigned sessions', async () => {
    const organizer = await User.create({ fullName: 'Org5', email: 'org5@example.com', role: Role.ORGANIZER });
    const staff = await User.create({ fullName: 'Staff5', email: 'staff5@example.com', role: Role.SYSTEM_USER });
    const outsider = await User.create({ fullName: 'Staff6', email: 'staff6@example.com', role: Role.SYSTEM_USER });
    const event = await Event.create({
      organizerId: organizer._id, title: 'Staffed Event', description: 'd', categoryId: new mongoose.Types.ObjectId(),
      format: 'PHYSICAL', schedule: { start: new Date(), end: new Date(Date.now() + 7200e3) }
    });
    const s1 = await Session.create({ eventId: event._id, name: 'Keynote', schedule: { start: new Date(), end: new Date(Date.now() + 3600e3) } });
    await Session.create({ eventId: event._id, name: 'Lunch', schedule: { start: new Date(), end: new Date(Date.now() + 3600e3) } });
    await SystemUserAssignment.create({ userId: staff._id, eventId: event._id, sessionIds: [s1._id], assignedBy: organizer._id });

    const staffToken = generateAccessToken((staff._id as any).toString(), Role.SYSTEM_USER);
    const res = await request(app).get(`/api/v1/events/${event._id}/sessions`).set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: any) => s.name)).toEqual(['Keynote']);

    const outsiderToken = generateAccessToken((outsider._id as any).toString(), Role.SYSTEM_USER);
    const denied = await request(app).get(`/api/v1/events/${event._id}/sessions`).set('Authorization', `Bearer ${outsiderToken}`);
    expect(denied.status).toBe(404);
  });
});

describe('Event detail read model', () => {
  it('resolves category, subcategory and template for display without changing stored ids', async () => {
    const organizer = await User.create({ fullName: 'Org7', email: 'org7@example.com', role: Role.ORGANIZER });
    const token = generateAccessToken((organizer._id as any).toString(), Role.ORGANIZER);
    const category = await Category.create({ name: 'Corporate Detail', subcategories: [{ name: 'Conference' }] });
    const template = await Template.create({ name: 'Gala Card', categoryId: category._id, previewImageKey: '/img/gala.png' });
    const event = await Event.create({
      organizerId: organizer._id, title: 'Detail Event', description: 'd', categoryId: category._id,
      subcategoryId: (category as any).subcategories[0]._id, templateId: template._id,
      format: 'PHYSICAL', schedule: { start: new Date(), end: new Date(Date.now() + 3600e3) }
    });

    const res = await request(app).get(`/api/v1/events/${event._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.categoryId.name).toBe('Corporate Detail');
    expect(res.body.data.subcategory.name).toBe('Conference');
    expect(res.body.data.templateId.name).toBe('Gala Card');
    expect(res.body.data.templateId.previewImageKey).toBe('/img/gala.png');

    // Updates still work against the raw references
    const upd = await request(app).patch(`/api/v1/events/${event._id}`).set('Authorization', `Bearer ${token}`).send({ title: 'Detail Event 2' });
    expect(upd.status).toBe(200);
    const stored = await Event.findById(event._id);
    expect(String(stored?.templateId)).toBe(String(template._id));
  });
});
