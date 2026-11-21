"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUpstashKV = createUpstashKV;
/**
 * Redis over HTTPS (Upstash's REST API): the only thing it needs from the host is outbound HTTPS, which shared Node hosting allows.
 * Every call is one request, with a short timeout, and throws on failure (the resilient wrapper decides what to do about that).
 */
function createUpstashKV(url, token, opts = {}) {
    const base = url.replace(/\/+$/, '');
    const f = opts.fetchImpl ?? fetch;
    const timeout = opts.timeoutMs ?? 1500;
    async function pipeline(commands) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeout);
        try {
            const res = await f(`${base}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands), signal: ctl.signal });
            if (!res.ok)
                throw new Error(`Redis HTTP ${res.status}`);
            const replies = (await res.json());
            return replies.map((r) => { if (r.error)
                throw new Error(`Redis: ${r.error}`); return r.result; });
        }
        finally {
            clearTimeout(timer);
        }
    }
    return {
        kind: 'upstash',
        async get(key) { const [r] = await pipeline([['GET', key]]); return r == null ? null : String(r); },
        async set(key, value, ttlMs) { await pipeline([ttlMs && ttlMs > 0 ? ['SET', key, value, 'PX', Math.ceil(ttlMs)] : ['SET', key, value]]); },
        async setNX(key, value, ttlMs) { const [r] = await pipeline([['SET', key, value, 'NX', 'PX', Math.ceil(ttlMs)]]); return r === 'OK'; },
        async del(...keys) { if (keys.length)
            await pipeline([['DEL', ...keys]]); },
        async incr(key, ttlMs) {
            // PEXPIRE ... NX only sets the expiry when the key has none: the window starts at the first hit and is never extended
            const [count, , left] = await pipeline([['INCR', key], ['PEXPIRE', key, Math.ceil(ttlMs), 'NX'], ['PTTL', key]]);
            return { count: Number(count), ttlMs: Number(left) > 0 ? Number(left) : ttlMs };
        },
        async decr(key) { await pipeline([['DECR', key]]); },
    };
}
