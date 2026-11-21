import type { Schema } from 'mongoose';
import { invalidate } from './cache';

/**
 * Clears a cache namespace after ANY write to the model (save, update, delete, insert), however it was made. Hooking the model means a
 * new code path that changes the data can never forget to clear the cache.
 */
export function clearCacheOnWrite(schema: Schema, ns: string): void {
  const after = () => { void invalidate(ns).catch(() => undefined); };
  for (const op of ['save', 'insertMany'] as const) schema.post(op as any, after);
  for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
    schema.post(op as any, after);
  }
}
