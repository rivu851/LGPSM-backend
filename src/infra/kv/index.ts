import type { KV } from './types';
import { createMemoryKV } from './memory';
import { createUpstashKV } from './upstash';

export type { KV } from './types';

/**
 * Wraps the real store so that a Redis outage never takes the app down: after an error it carries on in memory for a short while, then
 * tries Redis again. In memory, limits and caches are per server (exactly how they behave today), so the app stays correct on one server.
 */
export function createResilientKV(primary: KV, fallback: KV, opts: { retryAfterMs?: number; log?: (msg: string) => void; now?: () => number } = {}): KV {
  const retryAfter = opts.retryAfterMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.warn(m));
  let downUntil = 0;
  const run = async <T>(op: (kv: KV) => Promise<T>): Promise<T> => {
    if (now() >= downUntil) {
      try { return await op(primary); } catch (e: any) {
        downUntil = now() + retryAfter;
        log(`Redis unavailable (${e?.message || e}); using memory for ${Math.round(retryAfter / 1000)} s`);
      }
    }
    return op(fallback);
  };
  return {
    get kind() { return now() >= downUntil ? primary.kind : fallback.kind; },
    get: (k) => run((s) => s.get(k)),
    set: (k, v, t) => run((s) => s.set(k, v, t)),
    setNX: (k, v, t) => run((s) => s.setNX(k, v, t)),
    del: (...k) => run((s) => s.del(...k)),
    incr: (k, t) => run((s) => s.incr(k, t)),
    decr: (k) => run((s) => s.decr(k)),
  };
}

/** Puts every key under a prefix (so dev, test and production can share one Redis without touching each other's data) */
export function withPrefix(inner: KV, prefix: string): KV {
  const p = (k: string) => prefix + k;
  return {
    get kind() { return inner.kind; },
    get: (k) => inner.get(p(k)),
    set: (k, v, t) => inner.set(p(k), v, t),
    setNX: (k, v, t) => inner.setNX(p(k), v, t),
    del: (...k) => inner.del(...k.map(p)),
    incr: (k, t) => inner.incr(p(k), t),
    decr: (k) => inner.decr(p(k)),
  };
}

function build(): KV {
  const memory = createMemoryKV();
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const prefix = process.env.KV_PREFIX || 'eqr:';
  if (url && token && process.env.NODE_ENV !== 'test') return withPrefix(createResilientKV(createUpstashKV(url, token), memory), prefix);
  return withPrefix(memory, prefix);
}

/** The app's key-value store: memory now; Upstash Redis when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set. */
export const kv: KV = build();
