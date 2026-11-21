"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMemoryKV = createMemoryKV;
/** In the server's own memory. Entries expire on their own; the store is capped so it can never grow without bound. */
function createMemoryKV(opts = {}) {
    const max = opts.maxEntries ?? 50_000;
    const now = opts.now ?? Date.now;
    const map = new Map();
    const live = (key) => {
        const e = map.get(key);
        if (!e)
            return undefined;
        if (e.exp !== 0 && e.exp <= now()) {
            map.delete(key);
            return undefined;
        }
        return e;
    };
    const put = (key, v, ttlMs) => {
        map.delete(key); // re-insert so the oldest entries are the first to go when the cap is reached
        map.set(key, { v, exp: ttlMs && ttlMs > 0 ? now() + ttlMs : 0 });
        while (map.size > max)
            map.delete(map.keys().next().value);
    };
    // expired entries nobody reads again are swept out once a minute
    const sweeper = setInterval(() => { for (const k of [...map.keys()])
        live(k); }, opts.sweepMs ?? 60_000);
    sweeper.unref?.();
    return {
        kind: 'memory',
        async get(key) { return live(key)?.v ?? null; },
        async set(key, value, ttlMs) { put(key, value, ttlMs); },
        async setNX(key, value, ttlMs) {
            if (live(key))
                return false;
            put(key, value, ttlMs);
            return true;
        },
        async del(...keys) { keys.forEach((k) => map.delete(k)); },
        async incr(key, ttlMs) {
            const e = live(key);
            if (!e) {
                put(key, '1', ttlMs);
                return { count: 1, ttlMs };
            }
            e.v = String((Number(e.v) || 0) + 1);
            return { count: Number(e.v), ttlMs: e.exp === 0 ? ttlMs : Math.max(0, e.exp - now()) };
        },
        async decr(key) {
            const e = live(key);
            if (e)
                e.v = String(Math.max(0, (Number(e.v) || 0) - 1));
        },
        size: () => map.size,
        stop: () => clearInterval(sweeper),
    };
}
