/**
 * One email, several accounts. Accounts may share an email address and phone number (an organizer can also be someone's system
 * user, and a system user can also run their own events); login tells them apart by password and portal (role). This file walks
 * every flow where two accounts on one email could be mixed up: creating them, signing in, a forgotten password (link and mobile
 * code), organizer sign-up verification, changing a pending sign-up's email, removing one account, and what each list shows.
 * Everything goes through the real routes. Mail is mocked: nothing is sent, and codes/links are read from the mocked mail.
 */
import request from 'supertest';
import * as xlsx from 'xlsx';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event } from '../src/models/Event';
import { Category } from '../src/models/Category';
import { Invitee } from '../src/models/Invitee';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { EmailVerification } from '../src/models/EmailVerification';
import { PasswordResetOtp } from '../src/models/PasswordResetOtp';
import { hashPassword } from '../src/utils/password';
import { generateAccessToken } from '../src/utils/token';

const mockSendEmail = jest.fn().mockResolvedValue(true);
jest.mock('../src/utils/email.provider', () => ({ sendEmail: (...a: any[]) => mockSendEmail(...a) }));
jest.setTimeout(90000);

let mongo: MongoMemoryServer; let admin: any; let orgA: any; let orgB: any;
const SHARED = 'sam@x.com';
const ORG_PW = 'OrgPass123!'; const STAFF_PW = 'StaffPass456!';
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
const login = (body: Record<string, unknown>) => request(app).post('/api/auth/login').send(body);
const addStaff = (who: any, body: Record<string, unknown>) => request(app).post('/api/users').set(auth(who)).send({ password: STAFF_PW, role: 'SYSTEM_USER', fullName: 'Sam Staff', ...body });
const settle = () => new Promise((r) => setTimeout(r, 150));
const mails = () => mockSendEmail.mock.calls.map((c) => ({ to: c[0] as string, subject: c[1] as string, html: c[2] as string }));
const lastMail = () => mails()[mails().length - 1];
const linksIn = (html: string) => [...html.matchAll(/href="([^"]*forgot-password[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const tokenOf = (link: string) => decodeURIComponent(new URL(link).searchParams.get('token')!);

beforeAll(async () => { mongo = await MongoMemoryServer.create(); process.env.JWT_SECRET = 'test_secret'; process.env.JWT_REFRESH_SECRET = 'test_refresh_secret'; await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  mockSendEmail.mockClear(); mockSendEmail.mockResolvedValue(true);
  await Promise.all([User.deleteMany({}), EmailVerification.deleteMany({}), PasswordResetOtp.deleteMany({}), Event.deleteMany({}), Category.deleteMany({}), SystemUserAssignment.deleteMany({}), Invitee.deleteMany({}).setOptions({ includeArchived: true } as any)]);
  const pw = await hashPassword(ORG_PW);
  admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', passwordHash: pw, role: Role.ADMIN, isActive: true });
  orgA = await User.create({ fullName: 'Sam Organizer', email: SHARED, phone: '919876500001', passwordHash: pw, role: Role.ORGANIZER, isActive: true, isEmailVerified: true, profile: { organizationName: 'Sam Events' } });
  orgB = await User.create({ fullName: 'Other Organizer', email: 'b@x.com', passwordHash: pw, role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
});

describe('creating accounts that share an email', () => {
  it("an organizer can be added as their own (or another organizer's) system user, and an admin can add them for an organizer", async () => {
    expect((await addStaff(orgA, { email: SHARED })).status).toBe(201);
    expect((await addStaff(orgB, { email: SHARED })).status).toBe(201);
    const orgC = await User.create({ fullName: 'Third Organizer', email: 'c@x.com', passwordHash: await hashPassword(ORG_PW), role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
    expect((await addStaff(admin, { email: SHARED, organizerId: String(orgC._id) })).status).toBe(201);
    expect((await User.find({ email: SHARED }).lean()).map((u: any) => u.role).sort()).toEqual(['ORGANIZER', 'SYSTEM_USER', 'SYSTEM_USER', 'SYSTEM_USER']);
  });
  it('a system user can be added as an organizer (by an admin, and by signing up), with their own password', async () => {
    await addStaff(orgB, { email: 'staff@x.com' });
    const byAdmin = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'Staff Org', email: 'staff@x.com', password: ORG_PW, role: 'ORGANIZER', profile: { organizationName: 'Staff Events' } });
    expect(byAdmin.status).toBe(201);
    // ...and from then on that email has its one organizer account: a second organizer cannot sign up on it, nor can an admin add one
    const signup = await request(app).post('/api/auth/register').send({ fullName: 'Staff Self', email: 'staff@x.com', password: 'SelfPass789!', role: 'ORGANIZER' });
    expect(signup.status).toBe(400);
    expect(signup.body.message).toMatch(/organizer account already uses this email/);
    const again = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'Twice', email: 'staff@x.com', password: ORG_PW, role: 'ORGANIZER', profile: { organizationName: 'Twice' } });
    expect(again.status).toBe(400);
    expect(await User.countDocuments({ email: 'staff@x.com', role: Role.ORGANIZER })).toBe(1);
  });
  it('the same organizer cannot list the same person twice as staff, and the message says so', async () => {
    expect((await addStaff(orgA, { email: SHARED })).status).toBe(201);
    const again = await addStaff(orgA, { email: SHARED.toUpperCase() });
    expect(again.status).toBe(400);
    expect(again.body.message).toBe('This person is already one of your system users.');
    expect(await User.countDocuments({ email: SHARED, role: Role.SYSTEM_USER })).toBe(1);
  });
  it('a deleted system user can only be brought back by an administrator (approved policy: organizers may not reactivate), without touching the organizer account', async () => {
    const first = await addStaff(orgA, { email: SHARED });
    await request(app).delete(`/api/users/${first.body.data._id}`).set(auth(orgA));
    // the organizer adding the same person again would reactivate them: refused
    const refused = await addStaff(orgA, { email: SHARED, password: 'NewStaffPass1!' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('STAFF_DEACTIVATED_ADMIN_ONLY');
    expect((await login({ email: SHARED, password: 'NewStaffPass1!', role: 'SYSTEM_USER' })).status).toBeGreaterThanOrEqual(400);
    // an administrator can, on behalf of that organizer
    const back = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'Staff Again', email: SHARED, role: 'SYSTEM_USER', password: 'NewStaffPass1!', phone: '919000000042', organizerId: String(orgA._id) });
    expect(back.status).toBe(201);
    expect(String(back.body.data._id)).toBe(String(first.body.data._id));
    expect(await User.countDocuments({ email: SHARED })).toBe(2);
    expect((await login({ email: SHARED, password: 'NewStaffPass1!', role: 'SYSTEM_USER' })).status).toBe(200);
  });
});

describe('signing in with a shared email', () => {
  it('different passwords: each account signs in with its own, with or without the portal named', async () => {
    const staff = (await addStaff(orgA, { email: SHARED })).body.data;
    for (const role of [undefined, 'ORGANIZER']) {
      const r = await login({ email: SHARED, password: ORG_PW, ...(role ? { role } : {}) });
      expect(r.status).toBe(200); expect(String(r.body.data.user._id)).toBe(String(orgA._id));
    }
    for (const role of [undefined, 'SYSTEM_USER']) {
      const r = await login({ email: SHARED, password: STAFF_PW, ...(role ? { role } : {}) });
      expect(r.status).toBe(200); expect(String(r.body.data.user._id)).toBe(staff._id);
    }
    expect((await login({ email: SHARED, password: 'wrong' })).status).toBe(401);
  });
  it('the same password on both: the portal decides; without a portal the sign-in refuses to guess', async () => {
    const staff = (await addStaff(orgA, { email: SHARED, password: ORG_PW })).body.data;
    const asOrg = await login({ email: SHARED, password: ORG_PW, role: 'ORGANIZER' });
    const asStaff = await login({ email: SHARED, password: ORG_PW, role: 'SYSTEM_USER' });
    expect(String(asOrg.body.data.user._id)).toBe(String(orgA._id));
    expect(String(asStaff.body.data.user._id)).toBe(staff._id);
    expect((await login({ email: SHARED, password: ORG_PW })).status).toBe(401);
  });
  it('the wrong portal for an email that has only one kind of account is refused with a clear message', async () => {
    await addStaff(orgB, { email: 'only.staff@x.com' });
    const r = await login({ email: 'only.staff@x.com', password: STAFF_PW, role: 'ORGANIZER' });
    expect(r.status).toBe(403); expect(r.body.message).toMatch(/not registered as organizer/);
  });
  it('a shared phone number signs in the right account by password and portal', async () => {
    const staff = (await addStaff(orgA, { email: 'phone.staff@x.com', phone: '9876500001' })).body.data;
    const o = await login({ phone: '9876500001', password: ORG_PW, role: 'ORGANIZER' });
    const s = await login({ phone: '9876500001', password: STAFF_PW, role: 'SYSTEM_USER' });
    expect(String(o.body.data.user._id)).toBe(String(orgA._id));
    expect(String(s.body.data.user._id)).toBe(staff._id);
  });
  it('a disabled account never blocks, and never opens, the other account on the same email', async () => {
    const staff = (await addStaff(orgA, { email: SHARED })).body.data;
    await User.updateOne({ _id: staff._id }, { isActive: false });
    expect((await login({ email: SHARED, password: STAFF_PW, role: 'SYSTEM_USER' })).status).toBe(401);
    expect((await login({ email: SHARED, password: ORG_PW, role: 'ORGANIZER' })).status).toBe(200);
  });
  it('removing the staff account (as the organizer does) leaves the organizer account working', async () => {
    const staff = (await addStaff(orgA, { email: SHARED })).body.data;
    const token = (await login({ email: SHARED, password: ORG_PW, role: 'ORGANIZER' })).body.data.accessToken;
    expect((await request(app).delete(`/api/users/${staff._id}`).set(auth(orgA))).status).toBe(200);
    expect((await login({ email: SHARED, password: STAFF_PW, role: 'SYSTEM_USER' })).status).toBe(401);
    expect((await request(app).get('/api/users/profile').set({ Authorization: `Bearer ${token}` })).status).toBe(200);
  });
});

describe('a forgotten password with a shared email', () => {
  it('the emailed link resets the account the person asked for: the mail offers one link per account, and each only changes its own', async () => {
    const staff = (await addStaff(orgA, { email: SHARED })).body.data;
    expect((await request(app).post('/api/auth/forgot-password').send({ email: SHARED })).status).toBe(200);
    await settle();
    const mail = mails().filter((m) => m.to === SHARED && /Reset your LGPSM password/.test(m.subject));
    expect(mail.length).toBeGreaterThanOrEqual(1);
    const links = mail.flatMap((m) => linksIn(m.html));
    expect(links.length).toBe(2); // one for each account, not just whichever was created first
    expect(links.some((l) => /mode=organizer/.test(l))).toBe(true);
    expect(links.some((l) => /mode=app/.test(l))).toBe(true);
    const orgLink = links.find((l) => /mode=organizer/.test(l))!;
    expect((await request(app).post('/api/auth/reset-password').send({ token: tokenOf(orgLink), newPassword: 'BrandNewOrg1!' })).status).toBe(200);
    expect((await login({ email: SHARED, password: 'BrandNewOrg1!', role: 'ORGANIZER' })).status).toBe(200);
    expect((await login({ email: SHARED, password: STAFF_PW, role: 'SYSTEM_USER' })).status).toBe(200); // the staff account is untouched
    expect(String((await User.findById(staff._id))!.passwordHash).length).toBeGreaterThan(10);
  });
  it('the mobile code: the portal named in the request decides which account the reset token belongs to', async () => {
    const staff = (await addStaff(orgA, { email: SHARED })).body.data;
    for (const [role, expected, newPw] of [['SYSTEM_USER', staff._id, 'MobileStaff1!'], ['ORGANIZER', String(orgA._id), 'MobileOrg2!']] as const) {
      mockSendEmail.mockClear();
      await PasswordResetOtp.deleteMany({});
      expect((await request(app).post('/api/auth/forgot-password/otp').send({ email: SHARED, role })).status).toBe(200);
      await settle();
      const code = lastMail().html.match(/>\s*(\d{4})\s*<\/span>/)![1];
      const verified = await request(app).post('/api/auth/forgot-password/verify-otp').send({ email: SHARED, code, role });
      expect(verified.status).toBe(200);
      expect((await request(app).post('/api/auth/reset-password').send({ token: verified.body.data.resetToken, newPassword: newPw })).status).toBe(200);
      const signedIn = await login({ email: SHARED, password: newPw, role });
      expect(String(signedIn.body.data.user._id)).toBe(String(expected));
    }
  });
  it('the mobile code without a portal still resets one account (the staff one: the mobile app is for staff) and never both', async () => {
    const staff = (await addStaff(orgA, { email: SHARED })).body.data;
    await request(app).post('/api/auth/forgot-password/otp').send({ email: SHARED });
    await settle();
    const code = lastMail().html.match(/>\s*(\d{4})\s*<\/span>/)![1];
    const verified = await request(app).post('/api/auth/forgot-password/verify-otp').send({ email: SHARED, code });
    expect(verified.status).toBe(200);
    await request(app).post('/api/auth/reset-password').send({ token: verified.body.data.resetToken, newPassword: 'NoRoleReset1!' });
    expect((await login({ email: SHARED, password: 'NoRoleReset1!', role: 'SYSTEM_USER' })).status).toBe(200);
    expect((await login({ email: SHARED, password: ORG_PW, role: 'ORGANIZER' })).status).toBe(200);
    expect(String((await login({ email: SHARED, password: 'NoRoleReset1!', role: 'SYSTEM_USER' })).body.data.user._id)).toBe(staff._id);
  });
});

describe('organizer sign-up on an email another account already uses', () => {
  const signup = (body: Record<string, unknown> = {}) => request(app).post('/api/auth/register').send({ fullName: 'New Org', email: 'new@x.com', password: 'NewOrgPass1!', role: 'ORGANIZER', ...body });
  // the code is in the mail sent to the address the sign-up is on (an admin may also be notified of the new organizer)
  const code = (to = 'new@x.com') => [...mails()].reverse().find((m) => m.to === to && /\d{6}\s*<\/span>/.test(m.html))!.html.match(/>\s*(\d{6})\s*<\/span>/)![1];
  it('verifying the new organizer leaves the staff account on that email exactly as it was, and each portal signs in its own account', async () => {
    const staff = (await addStaff(orgB, { email: 'new@x.com' })).body.data;
    expect((await signup()).status).toBe(201);
    expect((await login({ email: 'new@x.com', password: 'NewOrgPass1!', role: 'ORGANIZER' })).status).toBe(403); // not verified yet
    expect((await request(app).post('/api/auth/verify-email').send({ email: 'new@x.com', code: code() })).status).toBe(200);
    const o = await login({ email: 'new@x.com', password: 'NewOrgPass1!', role: 'ORGANIZER' });
    expect(o.status).toBe(200); expect(o.body.data.user._id).not.toBe(staff._id);
    const s = await login({ email: 'new@x.com', password: STAFF_PW, role: 'SYSTEM_USER' });
    expect(String(s.body.data.user._id)).toBe(staff._id);
  });
  it('a second sign-up cannot take an email while another sign-up is waiting for its code, and cannot overwrite it', async () => {
    expect((await signup({ fullName: 'First', password: 'FirstPass123!' })).status).toBe(201);
    const firstCode = code();
    const second = await signup({ fullName: 'Second', password: 'SecondPass123!' });
    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/waiting for its verification code/);
    // the first sign-up (and its password) is untouched, and its own code still works
    expect((await request(app).post('/api/auth/verify-email').send({ email: 'new@x.com', code: firstCode })).status).toBe(200);
    expect((await login({ email: 'new@x.com', password: 'FirstPass123!', role: 'ORGANIZER' })).status).toBe(200);
    expect((await login({ email: 'new@x.com', password: 'SecondPass123!', role: 'ORGANIZER' })).status).toBe(401);
    expect(await User.countDocuments({ email: 'new@x.com', role: Role.ORGANIZER })).toBe(1);
  });
  it('a sign-up whose code ran out is cleared away so the real owner of the address can sign up', async () => {
    expect((await signup({ fullName: 'Squatter', password: 'SquatPass123!' })).status).toBe(201);
    await EmailVerification.updateOne({ email: 'new@x.com' }, { expiresAt: new Date(Date.now() - 1000) });
    const real = await signup({ fullName: 'Real Owner', password: 'RealPass123!' });
    expect(real.status).toBe(201);
    expect(await User.countDocuments({ email: 'new@x.com', role: Role.ORGANIZER })).toBe(1);
    expect((await User.findOne({ email: 'new@x.com' }))!.fullName).toBe('Real Owner');
    expect((await request(app).post('/api/auth/verify-email').send({ email: 'new@x.com', code: code() })).status).toBe(200);
    expect((await login({ email: 'new@x.com', password: 'SquatPass123!', role: 'ORGANIZER' })).status).toBe(401);
  });
  it('an organizer who is already verified keeps their email: signing up on it is refused, whatever the capitals', async () => {
    const r = await signup({ email: 'SAM@x.com' });
    expect(r.status).toBe(400); expect(r.body.message).toMatch(/organizer account already uses this email/);
    expect(r.body.code).toBe('ORGANIZER_EMAIL_IN_USE');
    expect(await User.countDocuments({ email: SHARED, role: Role.ORGANIZER })).toBe(1);
  });
  it('the database itself refuses two organizers on one email, but accepts staff and admin on it', async () => {
    await User.syncIndexes();
    await expect(User.create({ fullName: 'Dup', email: SHARED, passwordHash: 'x', role: Role.ORGANIZER, isActive: true })).rejects.toThrow(/duplicate key|E11000/);
    await expect(User.create({ fullName: 'Staff', email: SHARED, passwordHash: 'x', role: Role.SYSTEM_USER, isActive: true })).resolves.toBeTruthy();
    await expect(User.create({ fullName: 'Staff2', email: SHARED, passwordHash: 'x', role: Role.SYSTEM_USER, isActive: true })).resolves.toBeTruthy();
  });
  it("editing an account's email follows the same rules: an organizer cannot take another organizer's email, a system user cannot become a duplicate of one of the organizer's staff", async () => {
    const edit = (who: any, id: string, email: string) => request(app).patch(`/api/users/${id}`).set(auth(who)).send({ email });
    expect((await edit(admin, String(orgB._id), SHARED)).status).toBe(409);
    expect((await User.findById(orgB._id))!.email).toBe('b@x.com');
    await addStaff(orgA, { email: 'one@x.com', fullName: 'One' });
    const two = (await addStaff(orgA, { email: 'two@x.com', fullName: 'Two' })).body.data;
    expect((await edit(orgA, two._id, 'one@x.com')).status).toBe(409);
    expect((await edit(orgA, two._id, SHARED)).status).toBe(200); // the organizer's own email: staff and organizer may share
  });
  it('"change email address" on the code page works when a staff account already has that email, and moves only the sign-up', async () => {
    const staff = (await addStaff(orgB, { email: 'typo@x.com' })).body.data;
    expect((await signup({ email: 'typo@x.com' })).status).toBe(201);
    const moved = await request(app).post('/api/auth/change-pending-email').send({ email: 'typo@x.com', newEmail: 'fixed@x.com', password: 'NewOrgPass1!' });
    expect(moved.status).toBe(200);
    expect(await User.countDocuments({ email: 'fixed@x.com', role: Role.ORGANIZER })).toBe(1);
    expect((await User.findById(staff._id))!.email).toBe('typo@x.com'); // the staff account stayed where it was
    expect((await request(app).post('/api/auth/verify-email').send({ email: 'fixed@x.com', code: code('fixed@x.com') })).status).toBe(200);
  });
  it('"change email address" cannot move a sign-up onto an organizer\'s email, but can onto one only a system user uses', async () => {
    expect((await signup({ email: 'typo2@x.com' })).status).toBe(201);
    const refused = await request(app).post('/api/auth/change-pending-email').send({ email: 'typo2@x.com', newEmail: 'b@x.com', password: 'NewOrgPass1!' });
    expect(refused.status).toBe(409);
    expect((await User.findOne({ email: 'b@x.com', role: Role.ORGANIZER }))!.fullName).toBe('Other Organizer'); // untouched
    await addStaff(orgB, { email: 'staff.here@x.com' });
    const moved = await request(app).post('/api/auth/change-pending-email').send({ email: 'typo2@x.com', newEmail: 'staff.here@x.com', password: 'NewOrgPass1!' });
    expect(moved.status).toBe(200);
    expect((await request(app).post('/api/auth/verify-email').send({ email: 'staff.here@x.com', code: code('staff.here@x.com') })).status).toBe(200);
  });
  it('resending the code for an email that is also staff goes to the pending organizer sign-up only', async () => {
    await addStaff(orgB, { email: 'new@x.com' });
    await signup();
    mockSendEmail.mockClear();
    await EmailVerification.updateOne({ email: 'new@x.com' }, { lastSentAt: new Date(Date.now() - 120_000) });
    expect((await request(app).post('/api/auth/resend-verification').send({ email: 'new@x.com' })).status).toBe(200);
    expect(mails().filter((m) => m.to === 'new@x.com').length).toBe(1);
  });
});

describe('who sees which account', () => {
  it('an admin sees both accounts; an organizer sees only their own staff, never their own organizer account as staff', async () => {
    await addStaff(orgA, { email: SHARED });
    const all = await request(app).get('/api/users?limit=100').set(auth(admin));
    const rows: any[] = all.body.data.users ?? all.body.data;
    expect(rows.filter((u) => u.email === SHARED).map((u) => u.role).sort()).toEqual(['ORGANIZER', 'SYSTEM_USER']);
    const mine = await request(app).get('/api/users?role=SYSTEM_USER&limit=100').set(auth(orgA));
    const mineRows: any[] = mine.body.data.users ?? mine.body.data;
    expect(mineRows.every((u) => u.role === 'SYSTEM_USER')).toBe(true);
    expect(mineRows.filter((u) => u.email === SHARED).length).toBe(1);
    const others = await request(app).get('/api/users?role=SYSTEM_USER&limit=100').set(auth(orgB));
    expect(((others.body.data.users ?? others.body.data) as any[]).filter((u) => u.email === SHARED).length).toBe(0);
  });
  it('an organizer cannot manage the staff account of another organizer even when it shares an email with their own', async () => {
    const foreign = (await addStaff(orgB, { email: SHARED })).body.data;
    const r = await request(app).patch(`/api/users/${foreign._id}`).set(auth(orgA)).send({ fullName: 'Hijacked' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await User.findById(foreign._id))!.fullName).toBe('Sam Staff');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The same person can be an organizer and a system user, on the same event or on different ones (a small event may be run, and
// worked, by one person). The earlier "not on the event you run" rule is switched off (see systemUserAssignment.service.ts).
describe('an organizer who is also a system user (and the reverse): the same event or different ones', () => {
  const day = 864e5;
  let corp: any; let eventA: any; let eventB: any;
  const assign = (who: any, ev: any, userId: string) => request(app).post(`/api/v1/events/${ev._id}/assignments`).set(auth(who)).send({ userId, sessionIds: [] });
  beforeEach(async () => {
    corp = await Category.create({ name: 'Corporate', isActive: true });
    const mk = (org: any, title: string) => Event.create({ organizerId: org._id, title, description: 'd', categoryId: corp._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
    eventA = await mk(orgA, "Sam's own event");   // run by Sam (the organizer)
    eventB = await mk(orgB, "Other's event");     // run by someone else
  });

  it("an organizer also works the event they run as a system user, assigned by themselves or by an admin (a small event done by one person)", async () => {
    const samStaff = (await addStaff(orgA, { email: SHARED })).body.data; // Sam adds themselves as staff
    expect((await assign(orgA, eventA, samStaff._id)).status).toBe(201);
    const samStaff2 = (await addStaff(admin, { email: SHARED, organizerId: String(orgA._id), fullName: 'Sam Again' }));
    expect(samStaff2.status).toBe(400); // already one of Sam's system users: listed once
    expect(await SystemUserAssignment.countDocuments({ eventId: eventA._id, userId: samStaff._id })).toBe(1);
    // and they can be assigned to someone else's event too, by that organizer
    const forB = (await addStaff(orgB, { email: SHARED, fullName: 'Sam For B' })).body.data;
    expect((await assign(orgB, eventB, forB._id)).status).toBe(201);
  });
  it('the organizer account itself can be assigned to an event they run, by themselves or by an admin', async () => {
    expect((await assign(orgA, eventA, String(orgA._id))).status).toBe(201);
    expect((await assign(admin, eventA, String(admin._id))).status).toBe(201);
    expect(await SystemUserAssignment.countDocuments({ eventId: eventA._id })).toBe(2);
  });
  it('a person who is staff on an event can run events of their own, and work those too', async () => {
    const staff = (await addStaff(orgB, { email: 'pat@x.com', fullName: 'Pat' })).body.data;
    expect((await assign(orgB, eventB, staff._id)).status).toBe(201);
    const pat = await User.create({ fullName: 'Pat', email: 'pat@x.com', passwordHash: await hashPassword(ORG_PW), role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
    const patsEvent: any = await Event.create({ organizerId: pat._id, title: "Pat's event", description: 'd', categoryId: corp._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
    expect((await assign(admin, patsEvent, staff._id)).status).toBe(201);
    expect(await SystemUserAssignment.countDocuments({ userId: staff._id })).toBe(2);
  });
  it('as staff Sam sees every event they are assigned to; as organizer, Sam still manages the events Sam runs', async () => {
    const samStaff = (await addStaff(orgB, { email: SHARED })).body.data;
    await assign(orgB, eventB, samStaff._id);
    const staffToken = (await login({ email: SHARED, password: STAFF_PW, role: 'SYSTEM_USER' })).body.data.accessToken;
    const mine = await request(app).get('/api/v1/users/me/assignments').set({ Authorization: `Bearer ${staffToken}` });
    expect(mine.status).toBe(200); expect(JSON.stringify(mine.body.data)).toContain(String(eventB._id));
    const orgToken = (await login({ email: SHARED, password: ORG_PW, role: 'ORGANIZER' })).body.data.accessToken;
    expect((await request(app).get(`/api/v1/events/${eventA._id}`).set({ Authorization: `Bearer ${orgToken}` })).status).toBe(200);
    expect((await request(app).get(`/api/v1/events/${eventB._id}`).set({ Authorization: `Bearer ${orgToken}` })).status).toBeGreaterThanOrEqual(403); // an organizer account cannot open another organizer's event
  });
});

describe('working an event as an assigned person: which login can do it', () => {
  it("the system user account (same email as the organizer) checks guests in on another organizer's event; the organizer account, assigned directly, only lists it", async () => {
    const day = 864e5;
    const corp: any = await Category.create({ name: 'Corporate', isActive: true });
    const eventB: any = await Event.create({ organizerId: orgB._id, title: 'Other event', description: 'd', categoryId: corp._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + day) } });
    const staff = (await addStaff(orgB, { email: SHARED })).body.data;
    await SystemUserAssignment.create({ userId: staff._id, eventId: eventB._id, sessionIds: [], assignedBy: orgB._id });
    await SystemUserAssignment.create({ userId: orgA._id, eventId: eventB._id, sessionIds: [], assignedBy: admin._id });
    const staffToken = { Authorization: `Bearer ${generateAccessToken(staff._id, Role.SYSTEM_USER)}` };
    const orgToken = { Authorization: `Bearer ${generateAccessToken(String(orgA._id), Role.ORGANIZER)}` };
    // the person's system user login lists the event and can open it for check-in duty
    const mine = await request(app).get('/api/v1/users/me/assignments').set(staffToken);
    expect(mine.status).toBe(200); expect(JSON.stringify(mine.body.data)).toContain(String(eventB._id));
    const asStaff = await request(app).get(`/api/v1/events/${eventB._id}`).set(staffToken);
    expect(asStaff.status).toBe(200);
    // the organizer login, even if an admin assigned that account directly, has no way into another organizer's event: it would be
    // management access (edit, cancel, guests), not check-in duty. The way to work another event is the system user login.
    const asOrg = await request(app).get(`/api/v1/events/${eventB._id}`).set(orgToken);
    expect(asOrg.status).toBeGreaterThanOrEqual(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The scenario in one place: abc@example.com is an organizer AND a system user. That is fine, on the same event or on others (a small
// event may be run by one person who also works it). And that same address can always be on an invitee list (so they get their own
// invitation, pass and food), on any event, including events they work or run.
describe('abc@example.com: an organizer and a system user on one email', () => {
  const ABC = 'abc@example.com';
  const day = 864e5;
  let abc: any; let abcStaff: any; let e1: any; let e2: any;
  const mkEvent = (org: any, title: string) => Event.create({ organizerId: org._id, title, description: 'd', categoryId: null as any, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
  const assign = (who: any, ev: any, userId: string) => request(app).post(`/api/v1/events/${ev._id}/assignments`).set(auth(who)).send({ userId, sessionIds: [] });
  const guest = (who: any, ev: any, body: Record<string, unknown>) => request(app).post(`/api/v1/events/${ev._id}/invitees`).set(auth(who)).send(body);
  const uploadList = (who: any, ev: any, rows: string[][]) => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['Name', 'Email', 'Mobile'], ...rows]), 'Invitees'); return request(app).post(`/api/v1/events/${ev._id}/invitees/import`).set(auth(who)).field('mode', 'APPEND').attach('file', xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'list.xlsx'); };
  beforeEach(async () => {
    const cat: any = await Category.create({ name: 'Corporate', isActive: true });
    abc = await User.create({ fullName: 'Abc Organizer', email: ABC, passwordHash: await hashPassword(ORG_PW), role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
    const mk = (org: any, title: string) => Event.create({ organizerId: org._id, title, description: 'd', categoryId: cat._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
    e1 = await mk(abc, "Abc's own event");
    e2 = await mk(orgB, "Other organizer's event");
  });

  it('both accounts can exist on abc@example.com', async () => {
    abcStaff = (await addStaff(abc, { email: ABC, fullName: 'Abc Staff' })).body.data;
    expect(abcStaff).toBeDefined();
    expect(await User.countDocuments({ email: ABC })).toBe(2);
  });

  it('the organizer can add or assign that system user to an event the organizer runs: by assigning, by adding the user from that event, or through an admin', async () => {
    abcStaff = (await addStaff(abc, { email: ABC, fullName: 'Abc Staff' })).body.data;
    expect((await assign(abc, e1, abcStaff._id)).status).toBe(201);
    expect((await assign(admin, e1, abcStaff._id)).status).toBe(409); // already on it: a duplicate assignment, not a clash of emails
    // "Add User" from the event's own tab creates the user, then assigns them to that event
    const again = await addStaff(abc, { email: 'ABC@example.com', fullName: 'Abc Again' });
    expect(again.status).toBe(400); // the same organizer already lists this person as staff
    expect(await SystemUserAssignment.countDocuments({ eventId: e1._id })).toBe(1);
    const other = await addStaff(abc, { email: 'helper@example.com', fullName: 'Helper' });
    expect((await assign(abc, e1, other.body.data._id)).status).toBe(201);
  });

  it('the same person works another organizer\'s event as a system user, assigned by that organizer', async () => {
    const staffForB = (await addStaff(orgB, { email: ABC, fullName: 'Abc Staff' })).body.data;
    expect((await assign(orgB, e2, staffForB._id)).status).toBe(201);
    const staffToken = (await login({ email: ABC, password: STAFF_PW, role: 'SYSTEM_USER' })).body.data.accessToken;
    expect((await request(app).get(`/api/v1/events/${e2._id}`).set({ Authorization: `Bearer ${staffToken}` })).status).toBe(200);
  });

  it('the address can be on the invitee list of an event where that person works as a system user (by hand, from Excel, either order)', async () => {
    const staffForB = (await addStaff(orgB, { email: ABC, fullName: 'Abc Staff' })).body.data;
    // guest first, then assigned
    expect((await guest(orgB, e2, { name: 'Abc Guest', email: ABC, mobile: '9876500090' })).status).toBe(201);
    expect((await assign(orgB, e2, staffForB._id)).status).toBe(201);
    // from Excel on another event, where the staff works too
    const e3: any = await Event.create({ organizerId: orgB._id, title: 'Third', description: 'd', categoryId: (await Category.findOne())!._id, format: 'PHYSICAL', status: 'PUBLISHED', contactNumber: '9007000891', location: { address: 'Kolkata' }, schedule: { start: new Date(Date.now() + day), end: new Date(Date.now() + 2 * day) } });
    expect((await assign(orgB, e3, staffForB._id)).status).toBe(201);
    const up = await uploadList(orgB, e3, [['Abc Guest', ABC, '9876500090'], ['Someone', 'someone@x.com', '9876500091']]);
    expect(up.status).toBe(200);
    expect(await Invitee.countDocuments({ email: ABC })).toBe(2); // one guest record per event: e2 and e3
    // the same address twice on ONE event is still a duplicate guest
    expect((await guest(orgB, e2, { name: 'Abc Twice', email: ABC })).status).toBe(409);
  });

  it("the organizer's own address can be a guest of the organizer's own event, and so can the system user's: invitation and food reach them like anyone", async () => {
    abcStaff = (await addStaff(abc, { email: ABC, fullName: 'Abc Staff' })).body.data;
    const g = await guest(abc, e1, { name: 'Abc As Guest', email: ABC, mobile: '9876500092' });
    expect(g.status).toBe(201);
    const id = g.body.data._id || g.body.data.id;
    const sent = await request(app).post(`/api/v1/events/${e1._id}/invitations/send`).set(auth(abc)).send({ inviteeIds: [id], channel: 'EMAIL' });
    expect(sent.status).toBe(200);
    expect(mails().some((m) => m.to === ABC && /invited/i.test(m.subject))).toBe(true);
    // and works the same event as a system user
    expect((await assign(abc, e1, abcStaff._id)).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Organizers and system users may share an email. An ADMINISTRATOR's email is never shared with any other account.
describe("an administrator's email is never shared", () => {
  const ADMIN_EMAIL = 'admin@x.com';
  it('no organizer or system user can be created on an admin\'s email, by an admin or by an organizer', async () => {
    const asStaff = await addStaff(orgA, { email: ADMIN_EMAIL });
    expect(asStaff.status).toBe(400); expect(asStaff.body.message).toMatch(/belongs to an administrator account/);
    const asStaffByAdmin = await addStaff(admin, { email: ADMIN_EMAIL, organizerId: String(orgA._id) });
    expect(asStaffByAdmin.status).toBe(400);
    const asOrganizer = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'Pretend', email: ADMIN_EMAIL.toUpperCase(), password: ORG_PW, role: 'ORGANIZER', profile: { organizationName: 'P' } });
    expect(asOrganizer.status).toBe(400);
    expect(await User.countDocuments({ email: ADMIN_EMAIL })).toBe(1);
  });
  it('an organizer cannot sign up on an admin\'s email, nor move a pending sign-up onto it', async () => {
    const signup = await request(app).post('/api/auth/register').send({ fullName: 'Pretend', email: ADMIN_EMAIL, password: 'NewOrgPass1!', role: 'ORGANIZER' });
    expect(signup.status).toBe(400); expect(signup.body.message).toMatch(/belongs to an administrator account/);
    expect((await request(app).post('/api/auth/register').send({ fullName: 'Real', email: 'typo@x.com', password: 'NewOrgPass1!', role: 'ORGANIZER' })).status).toBe(201);
    const moved = await request(app).post('/api/auth/change-pending-email').send({ email: 'typo@x.com', newEmail: ADMIN_EMAIL, password: 'NewOrgPass1!' });
    expect(moved.status).toBe(409);
    expect(await User.findOne({ email: 'typo@x.com' })).not.toBeNull();
  });
  it('no admin can be created on an email another account already uses (organizer or system user), but can on a fresh one', async () => {
    await addStaff(orgA, { email: 'staff.here@x.com' });
    for (const email of [SHARED, 'staff.here@x.com']) {
      const r = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'New Admin', email, password: ORG_PW, role: 'ADMIN' });
      expect(r.status).toBe(400); expect(r.body.message).toMatch(/cannot be an administrator account/);
    }
    const fresh = await request(app).post('/api/users').set(auth(admin)).send({ fullName: 'New Admin', email: 'second.admin@x.com', password: ORG_PW, role: 'ADMIN' });
    expect(fresh.status).toBe(201);
  });
  it("changing an email follows it: nobody can take an admin's email, and an admin cannot take anyone else's", async () => {
    const edit = (who: any, id: string, email: string) => request(app).patch(`/api/users/${id}`).set(auth(who)).send({ email });
    const staff = (await addStaff(orgA, { email: 'someone@x.com', fullName: 'Someone' })).body.data;
    expect((await edit(orgA, staff._id, ADMIN_EMAIL)).status).toBe(409);
    expect((await edit(admin, String(orgB._id), ADMIN_EMAIL)).status).toBe(409);
    expect((await edit(admin, String(admin._id), SHARED)).status).toBe(409);
    expect((await User.findById(admin._id))!.email).toBe(ADMIN_EMAIL);
  });
  it('an organizer and a system user still share an email freely (only the admin is excluded)', async () => {
    expect((await addStaff(orgA, { email: SHARED })).status).toBe(201);
    expect((await addStaff(orgB, { email: SHARED, fullName: 'Another' })).status).toBe(201);
    expect(await User.countDocuments({ email: SHARED })).toBe(3);
  });
});
