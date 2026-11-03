"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userAuthCache = void 0;
exports.createUserAuthCache = createUserAuthCache;
const env_1 = require("../config/env");
// Every authenticated request has to confirm the account still exists, is active and what its role is. That read used to hit the
// database on every call; here the answer is kept for a few seconds. Any write to a user clears the whole cache (see models/User.ts),
// so a deactivation or role change applies at once on this server, and the TTL bounds the delay if another server instance made it.
// The test suite runs with no caching so each test sees exactly what it just wrote.
const DEFAULT_TTL_MS = env_1.env.NODE_ENV === 'test' ? 0 : 10_000;
const MAX_ENTRIES = 1000;
function createUserAuthCache(ttlMs, now = Date.now) {
    const entries = new Map();
    return {
        get(id) {
            if (ttlMs === 0)
                return undefined;
            const hit = entries.get(id);
            if (!hit)
                return undefined;
            if (now() - hit.at > ttlMs) {
                entries.delete(id);
                return undefined;
            }
            return { role: hit.role, isActive: hit.isActive };
        },
        set(id, value) {
            if (ttlMs === 0)
                return;
            if (entries.size >= MAX_ENTRIES)
                entries.clear();
            entries.set(id, { ...value, at: now() });
        },
        clear() {
            entries.clear();
        },
    };
}
exports.userAuthCache = createUserAuthCache(DEFAULT_TTL_MS);
