import { env } from '../config/env';

// Every authenticated request has to confirm the account still exists, is active and what its role is. That read used to hit the
// database on every call; here the answer is kept for a few seconds. Any write to a user clears the whole cache (see models/User.ts),
// so a deactivation or role change applies at once on this server, and the TTL bounds the delay if another server instance made it.
// The test suite runs with no caching so each test sees exactly what it just wrote.
const DEFAULT_TTL_MS = env.NODE_ENV === 'test' ? 0 : 10_000;
const MAX_ENTRIES = 1000;

export interface CachedAuthUser {
  role: string;
  isActive: boolean;
}

export function createUserAuthCache(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, CachedAuthUser & { at: number }>();
  return {
    get(id: string): CachedAuthUser | undefined {
      if (ttlMs === 0) return undefined;
      const hit = entries.get(id);
      if (!hit) return undefined;
      if (now() - hit.at > ttlMs) {
        entries.delete(id);
        return undefined;
      }
      return { role: hit.role, isActive: hit.isActive };
    },
    set(id: string, value: CachedAuthUser): void {
      if (ttlMs === 0) return;
      if (entries.size >= MAX_ENTRIES) entries.clear();
      entries.set(id, { ...value, at: now() });
    },
    clear(): void {
      entries.clear();
    },
  };
}

export const userAuthCache = createUserAuthCache(DEFAULT_TTL_MS);
