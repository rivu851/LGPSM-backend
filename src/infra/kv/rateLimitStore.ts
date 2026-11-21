import type { Store, Options, IncrementResponse, ClientRateLimitInfo } from 'express-rate-limit';
import { kv } from './index';

/** express-rate-limit's counters, kept in the key-value store: they expire by themselves when the window ends, and move to Redis with it. */
export class KvRateLimitStore implements Store {
  windowMs = 60_000;
  constructor(private readonly name: string) {}
  init(options: Options): void { this.windowMs = options.windowMs; }
  private key(k: string) { return `rl:${this.name}:${k}`; }
  async increment(key: string): Promise<IncrementResponse> {
    const { count, ttlMs } = await kv.incr(this.key(key), this.windowMs);
    return { totalHits: count, resetTime: new Date(Date.now() + ttlMs) };
  }
  async decrement(key: string): Promise<void> { await kv.decr(this.key(key)); }
  async resetKey(key: string): Promise<void> { await kv.del(this.key(key)); }
  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const v = await kv.get(this.key(key));
    return v == null ? undefined : { totalHits: Number(v), resetTime: undefined };
  }
}
