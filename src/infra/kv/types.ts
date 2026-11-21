/**
 * A small key-value store with expiry (TTL), the part of Redis this app uses. Today it runs in the server's own memory; setting the
 * Upstash variables swaps in real Redis (over HTTPS) with no other change. Values are strings (callers store JSON).
 */
export interface KV {
  readonly kind: 'memory' | 'upstash';
  get(key: string): Promise<string | null>;
  /** `ttlMs` omitted = no expiry */
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Sets the key only if it is not there yet; true when this call set it (a lock, or "first one wins") */
  setNX(key: string, value: string, ttlMs: number): Promise<boolean>;
  del(...keys: string[]): Promise<void>;
  /** Adds one. The expiry starts when the key is created (a fixed window). Returns the new count and the milliseconds left. */
  incr(key: string, ttlMs: number): Promise<{ count: number; ttlMs: number }>;
  decr(key: string): Promise<void>;
}
