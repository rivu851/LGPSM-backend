import mongoose, { Document, Schema } from 'mongoose';

/**
 * Remembers a create request that carried an `Idempotency-Key`, so a repeat of the same request (a double click, a retry after a lost
 * response, a second tab) returns the first answer instead of creating the thing again. The unique index is what decides between two
 * requests that arrive together. Records remove themselves after 24 hours.
 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface IIdempotencyKey extends Document {
  userId: mongoose.Types.ObjectId;
  scope: string;
  key: string;
  requestHash: string;
  state: 'PENDING' | 'DONE';
  status?: number;
  body?: unknown;
  createdAt: Date;
}

const IdempotencyKeySchema = new Schema<IIdempotencyKey>({
  userId: { type: Schema.Types.ObjectId, required: true },
  scope: { type: String, required: true },
  key: { type: String, required: true },
  requestHash: { type: String, required: true },
  state: { type: String, enum: ['PENDING', 'DONE'], default: 'PENDING' },
  status: { type: Number },
  body: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, index: { expires: IDEMPOTENCY_TTL_SECONDS } },
});
IdempotencyKeySchema.index({ userId: 1, scope: 1, key: 1 }, { unique: true });

export const IdempotencyKey = mongoose.model<IIdempotencyKey>('IdempotencyKey', IdempotencyKeySchema);
