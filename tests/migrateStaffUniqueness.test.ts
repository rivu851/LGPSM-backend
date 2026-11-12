import mongoose from 'mongoose';
import { execFileSync } from 'child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import path from 'path';

// scripts/migrate-staff-uniqueness.js, run for real against a throw-away in-memory database (never anything else: ATLAS_URL is set
// explicitly for each run, and dotenv does not override a variable that is already set).
jest.setTimeout(120_000);

describe('npm run migrate:staff-uniqueness', () => {
  let mongo: MongoMemoryServer; let users: mongoose.mongo.Collection;
  const run = (...args: string[]) => execFileSync('node', [path.join(__dirname, '..', 'scripts', 'migrate-staff-uniqueness.js'), ...args], { env: { ...process.env, ATLAS_URL: mongo.getUri() }, encoding: 'utf8' });
  const owner1 = new mongoose.Types.ObjectId(); const owner2 = new mongoose.Types.ObjectId();
  const staff = (email: string, createdBy: any, extra: any = {}) => ({ fullName: 'S', email, role: 'SYSTEM_USER', isActive: true, createdBy, passwordHash: 'x', ...extra });
  const indexNames = async () => (await users.indexes()).map((i: any) => i.name);
  const snapshot = async () => JSON.stringify(await users.find({}).sort({ _id: 1 }).toArray());

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    users = mongoose.connection.collection('users');
    await users.insertOne({ _id: new mongoose.Types.ObjectId(), fullName: 'Seed' } as any); // make sure the collection exists
    await users.deleteMany({});
    await users.dropIndex('uniq_active_staff_per_owner').catch(() => undefined); // the state of a database the migration has not been run on
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('report mode (the default) lists duplicates and changes nothing, not even the indexes', async () => {
    await users.insertMany([
      staff('dup@x.test', owner1), staff('DUP@x.test', owner1),          // the same person twice under one organizer
      staff('shared@x.test', owner1), staff('shared@x.test', owner2),    // the same person under two organizers: allowed
      staff('gone@x.test', owner1, { isActive: false }), staff('gone@x.test', owner1, { isActive: false }), // removed accounts: ignored
      staff('legacy@x.test', undefined as any), staff('legacy@x.test', undefined as any), // no owner: outside the rule
    ] as any);
    const before = await snapshot(); const idxBefore = await indexNames();
    const out = run();
    expect(out).toMatch(/more than once for the same organizer/);
    expect(out).toMatch(/dup@x\.test/);
    expect(out).not.toMatch(/shared@x\.test|gone@x\.test|legacy@x\.test/);
    expect(await snapshot()).toBe(before);
    expect(await indexNames()).toEqual(idxBefore);
  });
  it('--apply with duplicates present still creates nothing and edits nothing, and says what to resolve', async () => {
    const before = await snapshot();
    const out = run('--apply');
    expect(out).toMatch(/resolve these, then run again/);
    expect(await indexNames()).not.toContain('uniq_active_staff_per_owner');
    expect(await snapshot()).toBe(before);
  });
  it('once the duplicate is resolved by a person, --apply creates the index and still edits no record', async () => {
    await users.deleteOne({ email: 'DUP@x.test' });
    const before = await snapshot();
    expect(run()).toMatch(/No duplicate staff found\.[\s\S]*Report only/);
    expect(await indexNames()).not.toContain('uniq_active_staff_per_owner');
    expect(run('--apply')).toMatch(/Created unique index uniq_active_staff_per_owner/);
    const idx: any = (await users.indexes()).find((i: any) => i.name === 'uniq_active_staff_per_owner');
    expect(idx.unique).toBe(true);
    expect(idx.partialFilterExpression).toEqual({ role: 'SYSTEM_USER', isActive: true, createdBy: { $type: 'objectId' } });
    expect(await snapshot()).toBe(before);
  });
  it('it can be run again: the existing index is left alone', async () => {
    const before = await indexNames();
    expect(run('--apply')).toMatch(/already exists/);
    expect(await indexNames()).toEqual(before);
  });
  it('rollback is dropping that one index, and nothing else is needed', async () => {
    await users.dropIndex('uniq_active_staff_per_owner');
    expect(await indexNames()).not.toContain('uniq_active_staff_per_owner');
    await expect(users.insertMany([staff('after@x.test', owner1), staff('after@x.test', owner1)] as any)).resolves.toBeTruthy(); // duplicates allowed again
  });
});
