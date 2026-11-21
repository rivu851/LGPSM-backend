"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KvRateLimitStore = void 0;
const index_1 = require("./index");
/** express-rate-limit's counters, kept in the key-value store: they expire by themselves when the window ends, and move to Redis with it. */
class KvRateLimitStore {
    name;
    windowMs = 60_000;
    constructor(name) {
        this.name = name;
    }
    init(options) { this.windowMs = options.windowMs; }
    key(k) { return `rl:${this.name}:${k}`; }
    async increment(key) {
        const { count, ttlMs } = await index_1.kv.incr(this.key(key), this.windowMs);
        return { totalHits: count, resetTime: new Date(Date.now() + ttlMs) };
    }
    async decrement(key) { await index_1.kv.decr(this.key(key)); }
    async resetKey(key) { await index_1.kv.del(this.key(key)); }
    async get(key) {
        const v = await index_1.kv.get(this.key(key));
        return v == null ? undefined : { totalHits: Number(v), resetTime: undefined };
    }
}
exports.KvRateLimitStore = KvRateLimitStore;
