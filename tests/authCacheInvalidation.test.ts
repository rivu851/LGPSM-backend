import type mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// The auth cache is switched off under NODE_ENV=test, so this loads the modules as in development to prove that any write to a
// user empties it: a deactivation or role change must apply on the very next request, not after the TTL.
describe('auth cache is cleared by user writes', () => {
  let mongo: MongoMemoryServer;
  let cache: typeof import('../src/utils/userAuthCache').userAuthCache;
  let UserModel: typeof import('../src/models/User').User;
  const saved = process.env.NODE_ENV;

  let isolatedMongoose: typeof mongoose;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.NODE_ENV = 'development';
    // the isolated registry has its own mongoose, which has to be the one that connects
    jest.isolateModules(() => {
      isolatedMongoose = require('mongoose');
      cache = require('../src/utils/userAuthCache').userAuthCache;
      UserModel = require('../src/models/User').User;
    });
    process.env.NODE_ENV = saved;
    await isolatedMongoose.connect(mongo.getUri());
  });
  afterAll(async () => { await isolatedMongoose.disconnect(); await mongo.stop(); });

  const prime = (id: string) => cache.set(id, { role: 'ORGANIZER', isActive: true });

  it('really caches in this mode', () => {
    prime('x');
    expect(cache.get('x')).toBeDefined();
  });

  it.each([
    ['findByIdAndUpdate', (id: any) => UserModel.findByIdAndUpdate(id, { isActive: false })],
    ['updateOne', (id: any) => UserModel.updateOne({ _id: id }, { role: 'ADMIN' })],
    ['save', async (id: any) => { const u: any = await UserModel.findById(id); u.fullName = 'Renamed'; return u.save(); }],
    ['deleteOne', (id: any) => UserModel.deleteOne({ _id: id })],
  ])('after %s', async (_name, write) => {
    const u = await UserModel.create({ fullName: 'N', email: `${Math.random()}@x.com`, role: 'ORGANIZER' } as any);
    prime(String(u._id));
    expect(cache.get(String(u._id))).toBeDefined();
    await write(u._id);
    expect(cache.get(String(u._id))).toBeUndefined();
  });
});
