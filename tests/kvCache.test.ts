import { createMemoryKV } from '../src/infra/kv/memory';
import { createUpstashKV } from '../src/infra/kv/upstash';
import { createResilientKV, withPrefix } from '../src/infra/kv';

describe('memory key-value store', () => {
  it('expires entries by themselves (TTL)', async () => {
    let t = 1_000;
    const kv = createMemoryKV({ now: () => t });
    await kv.set('a', '1', 5_000);
    expect(await kv.get('a')).toBe('1');
    t += 4_999; expect(await kv.get('a')).toBe('1');
    t += 2; expect(await kv.get('a')).toBeNull();
    kv.stop();
  });

  it('counts within a fixed window that starts at the first hit and never stretches', async () => {
    let t = 0;
    const kv = createMemoryKV({ now: () => t });
    expect((await kv.incr('n', 10_000)).count).toBe(1);
    t += 6_000;
    const second = await kv.incr('n', 10_000);
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBe(4_000); // the window did not restart
    t += 4_001;
    expect((await kv.incr('n', 10_000)).count).toBe(1); // a new window
    await kv.decr('n'); expect(await kv.get('n')).toBe('0');
    kv.stop();
  });

  it('setNX lets only the first caller win, until it expires', async () => {
    let t = 0;
    const kv = createMemoryKV({ now: () => t });
    expect(await kv.setNX('lock', 'a', 1_000)).toBe(true);
    expect(await kv.setNX('lock', 'b', 1_000)).toBe(false);
    t += 1_001;
    expect(await kv.setNX('lock', 'c', 1_000)).toBe(true);
    kv.stop();
  });

  it('never grows past its cap: the oldest entries go first', async () => {
    const kv = createMemoryKV({ maxEntries: 3 });
    for (const k of ['a', 'b', 'c', 'd']) await kv.set(k, k);
    expect(kv.size()).toBe(3);
    expect(await kv.get('a')).toBeNull();
    expect(await kv.get('d')).toBe('d');
    kv.stop();
  });

  it('keeps prefixes apart', async () => {
    const mem = createMemoryKV();
    const dev = withPrefix(mem, 'dev:'), prod = withPrefix(mem, 'prod:');
    await dev.set('k', 'dev'); await prod.set('k', 'prod');
    expect(await dev.get('k')).toBe('dev'); expect(await prod.get('k')).toBe('prod');
    mem.stop();
  });
});

describe('Upstash (Redis over HTTPS) adapter', () => {
  const fake = (replies: any[][]) => {
    const calls: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => (replies.shift() ?? []).map((result) => ({ result })) } as any;
    }) as any;
    return { calls, kv: createUpstashKV('https://x.upstash.io/', 'tok', { fetchImpl }) };
  };

  it('sends the commands Redis expects, with the token', async () => {
    const f = fake([['OK'], ['v'], ['OK'], [3, 0, 8000]]);
    await f.kv.set('k', 'v', 5000);
    expect(await f.kv.get('k')).toBe('v');
    expect(await f.kv.setNX('lock', '1', 2000)).toBe(true);
    expect(await f.kv.incr('c', 10000)).toEqual({ count: 3, ttlMs: 8000 });
    expect(f.calls[0]).toEqual({ url: 'https://x.upstash.io/pipeline', auth: 'Bearer tok', body: [['SET', 'k', 'v', 'PX', 5000]] });
    expect(f.calls[2].body).toEqual([['SET', 'lock', '1', 'NX', 'PX', 2000]]);
    expect(f.calls[3].body).toEqual([['INCR', 'c'], ['PEXPIRE', 'c', 10000, 'NX'], ['PTTL', 'c']]);
  });

  it('a failing Redis is bridged by memory, then retried after a pause', async () => {
    let t = 0; let healthy = false; let logged = 0;
    const primary: any = { kind: 'upstash', get: async () => { if (!healthy) throw new Error('down'); return 'from-redis'; } };
    const mem = createMemoryKV();
    await mem.set('k', 'from-memory');
    const kv = createResilientKV(primary, mem, { retryAfterMs: 1000, now: () => t, log: () => { logged++; } });
    expect(await kv.get('k')).toBe('from-memory'); // the failure is absorbed
    expect(kv.kind).toBe('memory');
    healthy = true;
    expect(await kv.get('k')).toBe('from-memory'); // still resting
    t += 1001;
    expect(await kv.get('k')).toBe('from-redis'); // tried again
    expect(logged).toBe(1);
    mem.stop();
  });
});

describe('cache', () => {
  beforeAll(() => { process.env.ENABLE_CACHE_TESTS = 'true'; });
  afterAll(() => { delete process.env.ENABLE_CACHE_TESTS; });

  it('loads once, serves the rest from the cache, and a write clears the namespace', async () => {
    const { cached, invalidate } = await import('../src/infra/cache');
    let loads = 0;
    const load = async () => { loads++; await new Promise((r) => setTimeout(r, 20)); return { n: loads }; };
    // five requests at the same moment share one load
    const first = await Promise.all([1, 2, 3, 4, 5].map(() => cached('t1', 'k', 60, load)));
    expect(loads).toBe(1);
    expect(first.every((v) => v.n === 1)).toBe(true);
    expect((await cached('t1', 'k', 60, load)).n).toBe(1); // a hit
    expect(loads).toBe(1);
    await invalidate('t1');
    expect((await cached('t1', 'k', 60, load)).n).toBe(2); // after a write, loaded fresh
    // another namespace is untouched
    await cached('t2', 'k', 60, async () => 'x');
    await invalidate('t1');
    let t2loads = 0;
    expect(await cached('t2', 'k', 60, async () => { t2loads++; return 'y'; })).toBe('x');
    expect(t2loads).toBe(0);
  });

  it('expires after its TTL', async () => {
    const { cached } = await import('../src/infra/cache');
    let loads = 0;
    const load = async () => ++loads;
    await cached('ttl', 'k', 1, load);
    await cached('ttl', 'k', 1, load);
    expect(loads).toBe(1);
    await new Promise((r) => setTimeout(r, 1100));
    await cached('ttl', 'k', 1, load);
    expect(loads).toBe(2);
  });
});

describe('cached platform settings and categories follow their writes', () => {
  // these need a database: they use the same in-memory MongoDB as the other suites
  const mongoose = require('mongoose');
  const { MongoMemoryServer } = require('mongodb-memory-server');
  let mongo: any;
  beforeAll(async () => { process.env.ENABLE_CACHE_TESTS = 'true'; mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { delete process.env.ENABLE_CACHE_TESTS; await mongoose.disconnect(); await mongo.stop(); });

  it('a saved GST shows at once, with no waiting for the cache to expire', async () => {
    const { platformSettingsService } = require('../src/services/platformSettings.service');
    const admin = new mongoose.Types.ObjectId();
    expect(await platformSettingsService.gstPercent()).toBe(18);
    await platformSettingsService.gstPercent(); // now cached
    await platformSettingsService.updateGst(String(admin), 5);
    await new Promise((r) => setTimeout(r, 30)); // the clearing runs just after the write
    expect(await platformSettingsService.gstPercent()).toBe(5);
  });

  it('a new category appears in the list straight away', async () => {
    const { categoryService } = require('../src/services/category.service');
    const { Category } = require('../src/models/Category');
    await Category.create({ name: 'First', isActive: true });
    expect((await categoryService.getCategories(true)).map((c: any) => c.name)).toEqual(['First']);
    await Category.create({ name: 'Second', isActive: true });
    await new Promise((r) => setTimeout(r, 30));
    expect((await categoryService.getCategories(true)).map((c: any) => c.name).sort()).toEqual(['First', 'Second']);
  });
});
