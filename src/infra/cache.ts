import { kv } from './kv';

/**
 * Cache with expiry (TTL). A cached value belongs to a namespace ("categories", "settings"); changing the data clears the whole namespace at
 * once by bumping its generation number, so nothing has to track individual keys, and every server sees it (the number lives in the KV).
 * When several requests miss the same value at the same moment, only one runs the loader and the others wait for its answer.
 *
 * Off under test (like the account cache) so each test sees exactly what it wrote; a test that checks the cache itself turns it on with
 * ENABLE_CACHE_TESTS. Values are stored as JSON, so dates come back as ISO strings: cache plain data, not documents.
 */
const enabled = () => process.env.NODE_ENV !== 'test' || process.env.ENABLE_CACHE_TESTS === 'true';

const inflight = new Map<string, Promise<unknown>>();
const genMemo = new Map<string, { gen: string; at: number }>();
const GEN_MEMO_MS = 2_000; // how long this server trusts its own copy of a generation number (bounds how late another server's clear is seen)

async function generation(ns: string): Promise<string> {
  const memo = genMemo.get(ns);
  if (memo && Date.now() - memo.at < GEN_MEMO_MS) return memo.gen;
  const gen = (await kv.get(`gen:${ns}`)) ?? '0';
  genMemo.set(ns, { gen, at: Date.now() });
  return gen;
}

export async function cached<T>(ns: string, subKey: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  if (!enabled() || ttlSeconds <= 0) return loader();
  const key = `c:${ns}:${await generation(ns)}:${subKey}`;
  const hit = await kv.get(key);
  if (hit !== null) return JSON.parse(hit) as T;
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = (async () => {
    const value = await loader();
    // a value that is undefined cannot be stored as JSON: it is simply not cached
    if (value !== undefined) await kv.set(key, JSON.stringify(value), ttlSeconds * 1000).catch(() => undefined);
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Clears everything cached under the namespace. Call it after any write that changes what the cached values were built from. */
export async function invalidate(ns: string): Promise<void> {
  genMemo.delete(ns);
  for (const k of [...inflight.keys()]) if (k.startsWith(`c:${ns}:`)) inflight.delete(k);
  if (!enabled()) return;
  const { count } = await kv.incr(`gen:${ns}`, 365 * 24 * 3600 * 1000).catch(() => ({ count: 0 }));
  if (count) genMemo.set(ns, { gen: String(count), at: Date.now() });
}
