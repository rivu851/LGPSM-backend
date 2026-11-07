/**
 * A deployment whose database still has the OLD unique index on users.email (the migration has not been run): the app now lets an
 * organizer and a system user share an email, so the database refuses the second account. The person must be told what is wrong,
 * not shown "a record with the same unique value already exists", and the log must say what to run.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { hashPassword } from '../src/utils/password';
import { generateAccessToken } from '../src/utils/token';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.setTimeout(60000);

let mongo: MongoMemoryServer; let org: any;
const auth = (u: any) => ({ Authorization: `Bearer ${generateAccessToken(String(u._id), u.role)}` });
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await User.collection.drop().catch(() => {});
  await User.collection.createIndex({ email: 1 }, { name: 'email_1', unique: true }); // the legacy index
  org = await User.create({ fullName: 'Rivu', email: 'rivu851@gmail.com', passwordHash: await hashPassword('Pass12345!'), role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('the legacy unique email index', () => {
  it("makes adding the organizer's own email as a system user fail, and the answer says what to do", async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await request(app).post('/api/users').set(auth(org)).send({ fullName: 'Rivu Chattopadhyay', email: 'rivu851@gmail.com', phone: '9903107102', password: 'password123', role: 'SYSTEM_USER' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('USER_EMAIL_INDEX_OUTDATED');
    expect(r.body.message).not.toMatch(/same unique value/);
    expect(r.body.message).toMatch(/administrator|database/i);
    expect(spy.mock.calls.flat().join(' ')).toMatch(/migrate:user-contact-uniqueness/);
    spy.mockRestore();
  });
});

import { errorHandler } from '../src/middlewares/errorHandler';
describe('duplicate-key answers for a user email', () => {
  const answer = (err: any) => { let out: any; const res: any = { headersSent: false, status(c: number) { out = { status: c }; return this; }, json(b: any) { out = { ...out, ...b }; return this; } }; errorHandler(err, {} as any, res, () => {}); return out; };
  it('two organizer sign-ups meeting at the database: the one that lost is told an organizer already has this email', () => {
    const r = answer({ code: 11000, keyPattern: { email: 1 }, errmsg: 'E11000 duplicate key error collection: lgpsm.users index: uniq_organizer_email dup key: { email: "a@x.com" }' });
    expect(r.status).toBe(409); expect(r.code).toBe('ORGANIZER_EMAIL_IN_USE'); expect(r.message).toMatch(/organizer account already uses this email/);
  });
  it('any other duplicate keeps the general answer', () => {
    const r = answer({ code: 11000, keyPattern: { name: 1 }, errmsg: 'E11000 duplicate key error collection: lgpsm.categories index: name_1 dup key' });
    expect(r.status).toBe(409); expect(r.message).toBe('A record with the same unique value already exists');
  });
});
